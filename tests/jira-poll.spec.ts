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

const context = (run: (program: string, args: string[]) => Promise<string>) => {
  const received: Trigger[] = []
  const state = new Map<string, unknown>()
  const ctx = {
    config: () => ({ cli: 'jira', envFile: '', baseUrl: 'https://jira.example',
      projects: ['PROJ'], jql: 'assignee = currentUser()', pollSeconds: 300, maxTriggersPerRound: 20, commentLookback: 50 }),
    commands: { runWith: (program: string, args: string[]) => run(program, args) },
    receive: async (trigger: Trigger) => { received.push(trigger) },
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
    tickets: { open: () => [] }, threads: { describe: () => {} }, report: () => {},
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
  it('reads the comments a ticket has not seen yet', async () => {
    const comments = [{ id: '900', body: 'looks good', created: '2026-01-02T00:00:00.000+0000', author: { name: 'bob' } }]
    const { ctx, received, state } = context(cli([raw('PROJ-1')], comments))
    await pollRound(ctx)
    expect(received.map(trigger => trigger.threads[0]!.id)).toEqual(['PROJ-1', 'PROJ-1'])
    expect(received[1]!.text).toBe('looks good')
    expect(state.get(KV.jira.comment('PROJ-1'))).toBe('900')
    await pollRound(ctx)
    expect(received).toHaveLength(2)
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
