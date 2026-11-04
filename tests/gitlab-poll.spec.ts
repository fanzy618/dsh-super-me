import { describe, expect, it } from 'vitest'
import { pollRound } from '../src/sources/gitlab.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'

const mr = (state = 'opened') => ({ iid: 7, title: 'Fix PROJ-1', state, web_url: 'https://gitlab.example/acme/console/-/merge_requests/7',
  source_branch: 'agent/brave-otter', sha: 'abc', author: { username: 'fanzy618' } })
const note = (id: number, body: string, extra: Record<string, unknown> = {}) =>
  ({ id, body, created_at: '2026-01-01T00:00:00Z', author: { username: 'bob' }, system: false, ...extra })

const context = (options: { mr?: Record<string, unknown> | 'error'; notes?: unknown[]; notePages?: unknown[][]; ticket?: Record<string, unknown>; config?: Record<string, unknown> }) => {
  const received: Trigger[] = []
  const recorded: unknown[] = []
  const bound: unknown[] = []
  const closed: unknown[] = []
  const state = new Map<string, unknown>()
  const calls: string[][] = []
  const reports: { state: string; detail?: string }[] = []
  const runWith = async (_program: string, args: string[]): Promise<string> => {
    calls.push(args)
    if (args[1]?.includes('/notes')) {
      const page = Number(/[?&]page=(\d+)/.exec(args[1])?.[1] ?? '1')
      const pages = options.notePages ?? [options.notes ?? []]
      return JSON.stringify(pages[page - 1] ?? [])
    }
    if (options.mr === 'error') throw new Error('glab: 500')
    return JSON.stringify(options.mr ?? mr())
  }
  const ticket = { id: 't1', ended: undefined, repos: ['console'], deliverables: [{ repo: 'console', project: 'acme/console', kind: 'mr', ref: 7, state: 'open' }], ...options.ticket }
  const ctx = {
    config: () => ({ cli: 'glab', pollSeconds: 120, noteLookback: 100, ...options.config }),
    commands: { runWith },
    receive: async (trigger: Trigger) => { received.push(trigger) },
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
    tickets: { open: () => [ticket], record: (_id: string, item: { repo: string; state: string }) => { recorded.push(item); const row = (ticket.deliverables as { repo: string; state: string }[]).find(entry => entry.repo === item.repo); if (row) row.state = item.state },
      bindThread: (id: string, thread: unknown, own?: boolean) => { bound.push({ id, thread, own }) },
      threadClosed: (thread: unknown, outcome: string) => { closed.push({ thread, outcome }) } },
    threads: { describe: () => {} }, report: (_entry: string, value: { state: string }) => { reports.push(value) }, atomic: <T>(work: () => T): T => work(),
  } as unknown as SourceContext
  return { ctx, received, recorded, bound, closed, state, calls, reports }
}

describe('watching a merge request', () => {
  it('records its state and binds the ticket to its thread once', async () => {
    const { ctx, recorded, bound, received } = context({ notes: [note(900, 'please fix')] })
    await pollRound(ctx)
    expect(recorded[0]).toMatchObject({ repo: 'console', project: 'acme/console', ref: 7, state: 'open' })
    expect(bound).toHaveLength(1)
    expect(received.map(trigger => trigger.text)).toEqual(['please fix'])
    expect(received[0]!.threads[0]!.id).toBe('acme/console!7')
  })
  it('does not read the same note twice', async () => {
    const { ctx, received } = context({ notes: [note(900, 'please fix')] })
    await pollRound(ctx)
    await pollRound(ctx)
    expect(received).toHaveLength(1)
  })
  it('records a merge and closes the thread so the ticket can end', async () => {
    const { ctx, recorded, closed } = context({ mr: mr('merged') })
    await pollRound(ctx)
    expect(recorded[0]).toMatchObject({ state: 'merged' })
    expect(closed).toEqual([{ thread: { source: 'gitlab', id: 'acme/console!7' }, outcome: 'merged' }])
  })
  it('reports a close without merge as closed', async () => {
    const { ctx, closed } = context({ mr: mr('closed') })
    await pollRound(ctx)
    expect(closed[0]).toMatchObject({ outcome: 'closed' })
  })
  it('ignores a system note and a note the merge request author wrote', async () => {
    const { ctx, received } = context({ notes: [note(900, 'changed the milestone', { system: true }), note(901, 'mine', { author: { username: 'fanzy618' } })] })
    await pollRound(ctx)
    expect(received).toEqual([])
  })
})

it('binds a merge request first seen already merged, and closes it once', async () => {
  const { ctx, bound, closed, recorded } = context({ mr: mr('merged') })
  await pollRound(ctx)
  await pollRound(ctx)
  expect(bound).toEqual([{ id: 't1', thread: { source: 'gitlab', id: 'acme/console!7' }, own: true }])
  expect(closed).toEqual([{ thread: { source: 'gitlab', id: 'acme/console!7' }, outcome: 'merged' }])
  expect(recorded).toHaveLength(1)
})
it('reads past the first page of notes', async () => {
  const { ctx, received } = context({ notePages: [[note(3, 'third'), note(2, 'second')], [note(1, 'first')]], config: { noteLookback: 2 } })
  await pollRound(ctx)
  expect(received.map(trigger => trigger.text)).toEqual(['first', 'second', 'third'])
})
it('reports a merge request it could not read instead of pretending it is fine', async () => {
  const { ctx, reports, recorded } = context({ mr: 'error' })
  await pollRound(ctx)
  expect(recorded).toEqual([])
  expect(reports.at(-1)).toMatchObject({ state: 'error' })
})
it('finds a merge request in a nested group', async () => {
  const { gitlabKind } = await import('../src/sources/gitlab.ts')
  expect(gitlabKind.find!('acp/team/console!7').threads).toEqual(['gitlab:acp/team/console!7'])
})
