import { describe, expect, it } from 'vitest'
import { mrThread, noteTrigger, parseNote, parseMr, SOURCE, type Mr } from '../src/sources/gitlab-trigger.ts'
import { summarise } from '../src/core/deliverables.ts'
import type { Deliverable } from '../src/core/index.ts'

const mr = (overrides: Partial<Mr> = {}): Mr => ({ project: 'acme/console', iid: 7, title: 'Fix PROJ-1',
  state: 'open', webUrl: 'https://gitlab.example/acme/console/-/merge_requests/7', sourceBranch: 'agent/brave-otter',
  author: 'fanzy618', headSha: 'abc', ...overrides })

describe('merge requests as threads', () => {
  it('names a thread after its project and iid, so two projects never collide', () => {
    expect(mrThread('acme/console', 7)).toBe('gitlab:acme/console!7')
    expect(mrThread('acme/console', 7)).not.toBe(mrThread('acme/backend', 7))
  })
  it('parses the fields a ticket needs from the API answer', () => {
    expect(parseMr({ iid: 7, title: 'T', state: 'merged', web_url: 'u', source_branch: 'b', author: { username: 'fanzy618' }, sha: 'abc' }))
      .toEqual({ project: '', iid: 7, title: 'T', state: 'merged', webUrl: 'u', sourceBranch: 'b', author: 'fanzy618', headSha: 'abc' })
  })
  it('maps GitLab states onto the ones a deliverable records', () => {
    expect(parseMr({ iid: 1, state: 'opened' }).state).toBe('open')
    expect(parseMr({ iid: 1, state: 'merged' }).state).toBe('merged')
    expect(parseMr({ iid: 1, state: 'closed' }).state).toBe('closed')
    expect(parseMr({ iid: 1, state: 'locked' }).state).toBe('open')
  })
})

describe('notes', () => {
  it('names a note trigger after the note, so a re-read is the same trigger', () => {
    const note = { id: 900, body: 'please fix', created: '2026-01-01T00:00:00Z', author: 'bob', system: false }
    expect(noteTrigger(mr(), note).id).toBe(noteTrigger(mr(), { ...note, created: 'later' }).id)
    expect(noteTrigger(mr(), note).id).not.toBe(noteTrigger(mr(), { ...note, id: 901 }).id)
  })
  it('carries the merge request it belongs to and the author as the actor', () => {
    const trigger = noteTrigger(mr(), { id: 900, body: 'please fix', created: '2026-01-01T00:00:00Z', author: 'bob', system: false })
    expect(trigger).toMatchObject({ source: SOURCE, threads: [{ source: SOURCE, id: 'acme/console!7' }], actor: { source: SOURCE, id: 'bob' },
      human: true, text: 'please fix' })
    expect(trigger.channel?.address).toMatchObject({ project: 'acme/console', iid: '7' })
  })
  it('keeps a system note out of the conversation', () => {
    expect(parseNote({ id: 1, body: 'changed the milestone', system: true }, 'bob')).toMatchObject({ system: true })
    const trigger = noteTrigger(mr(), { id: 1, body: 'changed the milestone', created: 'x', author: 'bob', system: true })
    expect(trigger.human).toBe(false)
  })
})

describe('deliverables', () => {
  const item = (repo: string, state: Deliverable['state']): Deliverable => ({ repo, project: `acme/${repo}`, kind: 'mr', ref: 1, state })
  it('is not done while any deliverable still waits for its merge request', () => {
    expect(summarise([item('console', 'open'), item('backend', 'pending')])).toBeUndefined()
  })
  it('is not done while any repository has no deliverable at all', () => {
    expect(summarise([], ['console'])).toBeUndefined()
    expect(summarise([item('console', 'merged')], ['console', 'backend'])).toBeUndefined()
  })
  it('ends merged only when every merge request merged', () => {
    expect(summarise([item('console', 'merged'), item('backend', 'merged')])).toBe('merged')
  })
  it('ends closed when one closed without merging', () => {
    expect(summarise([item('console', 'merged'), item('backend', 'closed')])).toBe('closed')
    expect(summarise([item('console', 'closed')])).toBe('closed')
  })
  it('treats a failed deliverable as unfinished rather than finished', () => {
    expect(summarise([item('console', 'failed')])).toBeUndefined()
  })
})
