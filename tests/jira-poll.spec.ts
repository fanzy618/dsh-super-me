import { describe, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { pollRound } from '../src/sources/jira.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'

/** A Jira CLI stand-in: it answers `me`, one page of issues, an issue view and its comments. */
const cli = (issues: unknown[], comments: unknown[] = []) => async (_program: string, args: string[]): Promise<string> => {
  if (args[0] === 'me') return 'alice\n'
  if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues)
  if (args[0] === 'issue' && args[1] === 'view' && args.includes('--comments')) return JSON.stringify({ fields: { comment: { comments } } })
  if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(issues[0] ?? {})
  return ''
}
const raw = (key: string, statusId = '3', assignee = 'alice') => ({ key, self: `https://jira.example/rest/api/2/issue/${key}`,
  fields: { summary: `Fix ${key}`, description: 'body', updated: '2026-01-01T00:00:00.000+0000', status: { id: statusId },
    assignee: assignee ? { name: assignee } : null, components: [], labels: [] } })

const context = (run: (program: string, args: string[]) => Promise<string>, tickets: unknown[] = [], overrides: Record<string, unknown> = {}) => {
  const received: Trigger[] = []
  const state = new Map<string, unknown>()
  const ctx = {
    config: () => ({ cli: 'jira', envFile: '', baseUrl: 'https://jira.example',
      projects: ['PROJ'], jql: 'assignee = currentUser()', pollSeconds: 300, maxTriggersPerRound: 20, commentLookback: 50, ...overrides }),
    commands: { runWith: (program: string, args: string[]) => run(program, args) },
    receive: async (trigger: Trigger) => { received.push(trigger) },
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
    tickets: { open: () => tickets }, threads: { describe: () => {} }, report: () => {},
    atomic: <T>(work: () => T): T => work(),
  } as unknown as SourceContext
  return { ctx, received, state }
}

describe('a polling round', () => {
  it('dispatches an issue once and remembers it', async () => {
    const { ctx, received } = context(cli([raw('PROJ-1')]))
    await pollRound(ctx)
    await pollRound(ctx)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ source: 'jira', threads: [{ source: 'jira', id: 'PROJ-1' }] })
  })
  it('records where an issue stands without replaying its comments, then reads new ones', async () => {
    let comments = [{ id: '900', body: 'old', created: '2026-01-01T00:00:00.000+0000', author: { name: 'bob' } }]
    // A ticket the issue's thread created watches the issue for comments from the next round on.
    const ticket = { channels: [{ source: 'jira', thread: 'jira:PROJ-1', address: { issue: 'PROJ-1' } }] }
    const { ctx, received, state } = context(async (program, args) => cli([raw('PROJ-1')], comments)(program, args), [ticket])
    await pollRound(ctx)
    expect(received).toHaveLength(1)
    expect(state.get(KV.jira.comment('PROJ-1'))).toBe('900')
    comments = [...comments, { id: '901', body: 'looks good', created: '2026-01-02T00:00:00.000+0000', author: { name: 'bob' } }]
    await pollRound(ctx)
    expect(received).toHaveLength(2)
    expect(received[1]!.text).toBe('looks good')
    expect(state.get(KV.jira.comment('PROJ-1'))).toBe('901')
  })
  it('does not move the cursor when the comment window is full', async () => {
    const comments = [{ id: '900', body: 'a', created: '2026-01-01T00:00:00.000+0000', author: { name: 'bob' } },
      { id: '901', body: 'b', created: '2026-01-02T00:00:00.000+0000', author: { name: 'bob' } }]
    const received: Trigger[] = []
    const run = cli([raw('PROJ-1')], comments)
    const state = new Map<string, unknown>()
    state.set(KV.jira.comment('PROJ-1'), '800')
    const ctx = {
      config: () => ({ cli: 'jira', envFile: '', baseUrl: '', projects: ['PROJ'], jql: 'x', pollSeconds: 300, maxTriggersPerRound: 20, commentLookback: 2 }),
      commands: { runWith: (program: string, args: string[]) => run(program, args) },
      receive: async (trigger: Trigger) => { received.push(trigger) },
      state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) } },
      tickets: { open: () => [{ channels: [{ source: 'jira', thread: 'jira:PROJ-1', address: { issue: 'PROJ-1' } }] }] }, threads: { describe: () => {} }, report: () => {}, atomic: <T>(work: () => T): T => work(),
    } as unknown as SourceContext
    await pollRound(ctx)
    expect(received.filter(trigger => trigger.meta.commentId)).toHaveLength(0)
    expect(state.get(KV.jira.comment('PROJ-1'))).toBe('800')
  })
  it('dispatches a changed issue again', async () => {
    let issues = [raw('PROJ-1')]
    const { ctx, received } = context(async (_program, args) => cli(issues)(_program, args))
    await pollRound(ctx)
    issues = [raw('PROJ-1', '4')]
    await pollRound(ctx)
    expect(received).toHaveLength(2)
  })
})

it('reads the first comment that arrives after a round with none', async () => {
  let comments: unknown[] = []
  const ticket = { channels: [{ source: 'jira', thread: 'jira:PROJ-1', address: { issue: 'PROJ-1' } }] }
  const { ctx, received, state } = context(async (program, args) => cli([raw('PROJ-1')], comments)(program, args), [ticket])
  await pollRound(ctx)
  expect(state.get(KV.jira.comment('PROJ-1'))).toBe('0')
  comments = [{ id: '900', body: 'first', created: '2026-01-02T00:00:00.000+0000', author: { name: 'bob' } }]
  await pollRound(ctx)
  expect(received.map(trigger => trigger.text)).toContain('first')
})

it('shares the round budget between issues and comments', async () => {
  const comments = [{ id: '900', body: 'a', created: '2026-01-02T00:00:00.000+0000', author: { name: 'bob' } }]
  const ticket = { channels: [{ source: 'jira', thread: 'jira:PROJ-1', address: { issue: 'PROJ-1' } }] }
  const { ctx, received, state } = context(async (program, args) => cli([raw('PROJ-1')], comments)(program, args), [ticket], { maxTriggersPerRound: 1 })
  await pollRound(ctx)
  await pollRound(ctx)
  // The one dispatch of the second round used the whole budget, so the comment waits.
  expect(received.filter(trigger => trigger.meta.commentId)).toHaveLength(0)
  expect(state.get(KV.jira.comment('PROJ-1'))).toBe('900')
})
