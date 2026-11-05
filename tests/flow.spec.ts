import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor } from '../src/core/index.ts'
import type { Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { noteTrigger, parseMr, parseNote } from '../src/sources/gitlab-trigger.ts'

/** One ticket that follows a merge request's thread, as a GitLab watch would leave it. */
const ticket = (): Ticket => ({ id: 't1', title: 'Fix PROJ-1', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'jira', id: 'alice' }, scope: '' },
  channels: [{ source: 'gitlab', thread: 'acme/console!7', address: { project: 'acme/console', iid: '7' } }],
  repos: ['console'], deliver: { kind: 'mr' },
  deliverables: [{ repo: 'console', project: 'acme/console', kind: 'mr', ref: 7, state: 'open' }],
  follows: [{ thread: 'gitlab:acme/console!7', own: true }],
  assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'source-1', triggerIds: [] } })

const flow = () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'flow-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({})
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  store.tickets.save(ticket())
  store.threads.save({ key: 'gitlab:acme/console!7', ref: { source: 'gitlab', id: 'acme/console!7' },
    createdAt: '', subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
  return { store, engine }
}

describe('a merge request and the ticket that follows it', () => {
  it('delivers a note to the ticket without starting new work', () => {
    const { store, engine } = flow()
    const trigger = noteTrigger(parseMr({ iid: 7, state: 'opened', project: 'acme/console', author: { username: 'fanzy618' } }),
      parseNote({ id: 900, body: 'please rebase', created_at: '2026-01-01T00:00:00Z', author: { username: 'bob' } }))
    engine.receive(trigger)
    const after = store.tickets.get('t1')!
    expect(after.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])).toEqual([trigger.id])
    // A watch-only Source never queues an evaluation, so no Decision exists for the note.
    expect(store.decisions.byThread('gitlab:acme/console!7')).toEqual([])
  })
  it('ends the ticket when the merge request merges', () => {
    const { store, engine } = flow()
    engine.threadClosed({ source: 'gitlab', id: 'acme/console!7' }, 'merged', '2026-01-02T00:00:00Z')
    expect(store.tickets.get('t1')!.ended).toMatchObject({ outcome: 'merged' })
  })
  it('ends it as closed when the merge request closes without merging', () => {
    const { store, engine } = flow()
    engine.threadClosed({ source: 'gitlab', id: 'acme/console!7' }, 'closed', '2026-01-02T00:00:00Z')
    expect(store.tickets.get('t1')!.ended).toMatchObject({ outcome: 'closed' })
  })
})
