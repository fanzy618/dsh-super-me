import { describe, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { pollRound } from '../src/sources/jira.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Health } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'

/** One Jira issue as the CLI returns it; `category` selects Jira's status category. */
const raw = (key: string, options: { statusId?: string; assignee?: string | null; category?: string; summary?: string } = {}) => ({
  key, self: `https://jira.example/rest/api/2/issue/${key}`,
  fields: { summary: options.summary ?? `Fix ${key}`, updated: '2026-01-01T00:00:00.000+0000',
    status: { id: options.statusId ?? '3', statusCategory: { key: options.category ?? 'indeterminate' } },
    assignee: options.assignee === null ? null : { name: options.assignee ?? 'alice' }, components: [], labels: [] },
})

interface Fake {
  /** One entry per `issue list` page, in call order; a string is a CLI failure. */
  pages?: (unknown[] | 'error' | 'garbage')[]
  /** Answers to `issue view <key> --raw`. */
  views?: Record<string, unknown | 'error' | 'garbage'>
  /** Answers to `issue view <key> --comments N --raw`. */
  comments?: Record<string, unknown[] | 'error'>
}
const runWith = (fake: Fake, calls: string[][]) => async (_program: string, args: string[]): Promise<string> => {
  calls.push(args)
  if (args[0] === 'me') return 'alice\n'
  if (args[0] === 'issue' && args[1] === 'list') {
    const page = fake.pages?.[calls.filter(call => call[1] === 'list').length - 1]
    if (page === 'error') throw new Error('jira: 500')
    if (page === 'garbage' || page === undefined) return 'not json'
    // The list output is trimmed: only the key and the timestamp.
    return JSON.stringify((page as { key: string; fields: { updated: string } }[]).map(issue => ({ key: issue.key, fields: { updated: issue.fields.updated } })))
  }
  if (args[0] === 'issue' && args[1] === 'view') {
    const key = args[2]!
    if (args.includes('--comments')) {
      const value = fake.comments?.[key] ?? []
      if (value === 'error') throw new Error('jira: comments failed')
      return JSON.stringify({ fields: { comment: { comments: value } } })
    }
    const view = fake.views?.[key] ?? (fake.pages ?? []).flatMap(page => Array.isArray(page) ? page : [])
      .find(issue => (issue as { key?: string }).key === key)
    if (view === 'error') throw new Error('jira: view failed')
    if (view === 'garbage' || view === undefined) return 'not json'
    return JSON.stringify(view)
  }
  return ''
}

const context = (fake: Fake, options: { tickets?: unknown[]; config?: Record<string, unknown>; seen?: Record<string, unknown>; pending?: unknown[]; cursor?: Record<string, string> } = {}) => {
  const received: Trigger[] = []
  const reports: Health[] = []
  const calls: string[][] = []
  const state = new Map<string, unknown>()
  if (options.seen) state.set(KV.jira.seen, options.seen)
  if (options.pending) state.set(KV.jira.pending, options.pending)
  for (const [key, value] of Object.entries(options.cursor ?? {})) state.set(KV.jira.comment(key), value)
  const config = { cli: 'jira', envFile: '', baseUrl: '', projects: ['PROJ'], jql: 'assignee = currentUser()',
    pollSeconds: 300, maxTriggersPerRound: 20, commentLookback: 50, ...options.config }
  const ctx = {
    config: () => config,
    commands: { runWith: (program: string, args: string[]) => runWith(fake, calls)(program, args) },
    receive: async (trigger: Trigger) => { received.push(trigger) },
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
    tickets: { open: () => options.tickets ?? [] }, threads: { describe: () => {} },
    report: (_entry: string, health: Health) => { reports.push(health) },
    atomic: <T>(work: () => T): T => work(),
  } as unknown as SourceContext
  return { ctx, received, reports, calls, state }
}

describe('pagination and incomplete rounds', () => {
  it('reads every page, and a full first page is not the end', async () => {
    const first = Array.from({ length: 100 }, (_, index) => raw(`PROJ-${index + 1}`))
    const { ctx, received, calls } = context({ pages: [first, [raw('PROJ-101')]] }, { config: { maxTriggersPerRound: 200 } })
    await pollRound(ctx)
    expect(received).toHaveLength(101)
    expect(calls.filter(call => call[1] === 'list').map(call => call.at(-1))).toEqual(['0:100', '100:100'])
  })
  it('changes nothing when a later page fails', async () => {
    const first = Array.from({ length: 100 }, (_, index) => raw(`PROJ-${index + 1}`))
    const { ctx, received, reports, state } = context({ pages: [first, 'error'] })
    await pollRound(ctx)
    expect(received).toEqual([])
    expect(state.get(KV.jira.seen)).toBeUndefined()
    expect(reports.at(-1)).toMatchObject({ state: 'error', code: 'jiraPollIncomplete' })
  })
  it('treats a record it cannot read as an incomplete round, not as the end of the page', async () => {
    const { ctx, received, state } = context({ pages: [[raw('PROJ-1'), { key: 'PROJ-2', fields: {} }]] })
    await pollRound(ctx)
    expect(received).toEqual([])
    expect(state.get(KV.jira.seen)).toBeUndefined()
  })
  it('changes nothing when one project cannot be read', async () => {
    const { ctx, received } = context({ pages: [[raw('PROJ-1')], 'error'] }, { config: { projects: ['PROJ', 'PLAT'] } })
    await pollRound(ctx)
    expect(received).toEqual([])
  })
})

describe('departures', () => {
  it('forgets reassigned and done issues in both the queue and the memory, and keeps the rest', async () => {
    const seen = { 'PROJ-A': { fingerprint: 'x', statusId: '3' }, 'PROJ-B': { fingerprint: 'y', statusId: '3' },
      'PROJ-C': { fingerprint: 'z', statusId: '3' }, 'PROJ-D': { fingerprint: 'w', statusId: '3' } }
    const pending = [{ key: 'PROJ-E', fingerprint: 'v' }]
    const fake: Fake = { pages: [[]], views: { 'PROJ-A': raw('PROJ-A', { assignee: 'bob' }),
      'PROJ-B': raw('PROJ-B', { category: 'done' }), 'PROJ-C': raw('PROJ-C'), 'PROJ-D': 'error', 'PROJ-E': raw('PROJ-E', { assignee: 'bob' }) } }
    const { ctx, state } = context(fake, { seen, pending })
    await pollRound(ctx)
    expect(Object.keys(state.get(KV.jira.seen) as object).sort()).toEqual(['PROJ-C', 'PROJ-D'])
    expect(state.get(KV.jira.pending)).toEqual([])
  })
  it('keeps a queued issue whose departure cannot be confirmed', async () => {
    const pending = [{ key: 'PROJ-E', fingerprint: 'v' }]
    const { ctx, state } = context({ pages: [[]], views: { 'PROJ-E': 'error' } }, { pending })
    await pollRound(ctx)
    expect(state.get(KV.jira.pending)).toEqual([{ key: 'PROJ-E', fingerprint: 'v' }])
  })
})

describe('comment budget and failures', () => {
  it('does not spend comment budget that dispatching issues already used', async () => {
    const ticket = { channels: [{ source: 'jira', thread: 'jira:PROJ-1', address: { issue: 'PROJ-1' } }] }
    const { ctx, received, state } = context({ pages: [[raw('PROJ-1')]],
      comments: { 'PROJ-1': [{ id: '900', body: 'a', created: '2026-01-02T00:00:00.000+0000', author: { name: 'bob' } }] } },
    { tickets: [ticket], cursor: { 'PROJ-1': '800' }, config: { maxTriggersPerRound: 1 } })
    await pollRound(ctx)
    expect(received.filter(trigger => trigger.meta.commentId)).toEqual([])
    expect(state.get(KV.jira.comment('PROJ-1'))).toBe('800')
  })
  it('does not move the cursor past a comment it could not read', async () => {
    const ticket = { channels: [{ source: 'jira', thread: 'jira:PROJ-1', address: { issue: 'PROJ-1' } }] }
    const { ctx, received, reports, state } = context({ pages: [[raw('PROJ-1')]], comments: { 'PROJ-1': 'error' } },
      { tickets: [ticket], cursor: { 'PROJ-1': '800' } })
    await pollRound(ctx)
    expect(received.filter(trigger => trigger.meta.commentId)).toEqual([])
    expect(state.get(KV.jira.comment('PROJ-1'))).toBe('800')
    expect(reports.at(-1)).toMatchObject({ state: 'error', code: 'jiraCommentsUnreadable' })
  })
  it('never feeds the agent its own comments back and moves past them', async () => {
    const ticket = { channels: [{ source: 'jira', thread: 'jira:PROJ-1', address: { issue: 'PROJ-1' } }] }
    const { ctx, received, state } = context({ pages: [[raw('PROJ-1')]],
      comments: { 'PROJ-1': [{ id: '900', body: 'mine', created: '2026-01-02T00:00:00.000+0000', author: { name: 'alice' } }] } },
    { tickets: [ticket], cursor: { 'PROJ-1': '800' } })
    await pollRound(ctx)
    expect(received.filter(trigger => trigger.meta.commentId)).toEqual([])
    expect(state.get(KV.jira.comment('PROJ-1'))).toBe('900')
  })
})
