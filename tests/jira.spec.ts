import { describe, expect, it } from 'vitest'
import { commentTrigger, fingerprint, issueTrigger, jiraThread, type JiraIssue } from '../src/sources/jira-trigger.ts'
import { plan } from '../src/sources/jira-plan.ts'

const issue = (overrides: Partial<JiraIssue> = {}): JiraIssue => ({
  key: 'PROJ-1', summary: 'Fix the regression', updated: '2026-01-01T00:00:00.000+0000', statusId: '3', assignee: 'alice',
  components: [], labels: [], url: 'https://jira.example/browse/PROJ-1', ...overrides })

describe('fingerprints', () => {
  it('ignores the updated timestamp so a comment of our own does not look like a change', () => {
    expect(fingerprint(issue({ updated: '2026-01-02T00:00:00.000+0000' }))).toBe(fingerprint(issue()))
  })
  it('changes when a field the ticket cares about changes', () => {
    expect(fingerprint(issue({ statusId: '4' }))).not.toBe(fingerprint(issue()))
    expect(fingerprint(issue({ assignee: 'bob' }))).not.toBe(fingerprint(issue()))
    expect(fingerprint(issue({ summary: 'Other' }))).not.toBe(fingerprint(issue()))
  })
})

describe('triggers', () => {
  it('names the issue trigger after the issue and its fingerprint', () => {
    const trigger = issueTrigger(issue())
    expect(trigger).toMatchObject({ source: 'jira', threads: [{ source: 'jira', id: 'PROJ-1' }], actor: { source: 'jira', id: 'alice' },
      human: true, addressed: 'direct', channel: { source: 'jira', thread: jiraThread('PROJ-1'), address: { issue: 'PROJ-1' } },
      meta: { issue: 'PROJ-1', statusId: '3' } })
    expect(trigger.id).toBe(issueTrigger(issue({ updated: 'later' })).id)
    expect(trigger.id).not.toBe(issueTrigger(issue({ statusId: '4' })).id)
  })
  it('names a comment trigger after the comment and keeps it on the issue thread', () => {
    const trigger = commentTrigger(issue(), { id: '900', body: 'looks good', author: 'bob', created: '2026-01-03T00:00:00.000+0000' })
    expect(trigger).toMatchObject({ source: 'jira', threads: [{ source: 'jira', id: 'PROJ-1' }], actor: { source: 'jira', id: 'bob' },
      human: true, text: 'looks good' })
    expect(commentTrigger(issue(), { id: '900', body: 'looks good', author: 'bob', created: 'later' }).id).toBe(trigger.id)
  })
})

describe('round planning', () => {
  const none = { seen: {}, pending: [] as { key: string; fingerprint: string }[], limit: 20, left: [] as string[], complete: true }
  it('dispatches an issue it has not seen', () => {
    const result = plan({ ...none, issues: [issue()] })
    expect(result.dispatch.map(item => item.key)).toEqual(['PROJ-1'])
    expect(result.seen['PROJ-1']?.fingerprint).toBe(fingerprint(issue()))
  })
  it('dispatches nothing twice for the same fingerprint', () => {
    const first = plan({ ...none, issues: [issue()] })
    const second = plan({ ...none, issues: [issue({ updated: 'later' })], seen: first.seen })
    expect(second.dispatch).toEqual([])
  })
  it('dispatches an issue whose fingerprint moved', () => {
    const first = plan({ ...none, issues: [issue()] })
    const second = plan({ ...none, issues: [issue({ statusId: '4' })], seen: first.seen })
    expect(second.dispatch.map(item => item.key)).toEqual(['PROJ-1'])
  })
  it('changes nothing when the round did not complete', () => {
    const first = plan({ ...none, issues: [issue()] })
    const second = plan({ ...none, issues: [], seen: first.seen, complete: false })
    expect(second.dispatch).toEqual([])
    expect(second.seen).toEqual(first.seen)
  })
  it('spreads dispatch over rounds without losing or repeating an issue', () => {
    const issues = [issue(), issue({ key: 'PROJ-2' }), issue({ key: 'PROJ-3' })]
    const first = plan({ ...none, issues, limit: 2 })
    expect(first.dispatch.map(item => item.key)).toEqual(['PROJ-1', 'PROJ-2'])
    expect(first.pending.map(item => item.key)).toEqual(['PROJ-3'])
    const second = plan({ ...none, issues, seen: first.seen, pending: first.pending, limit: 2 })
    expect(second.dispatch.map(item => item.key)).toEqual(['PROJ-3'])
    expect(second.pending).toEqual([])
  })
  it('forgets an issue only when the caller confirmed it left', () => {
    const first = plan({ ...none, issues: [issue()] })
    const unconfirmed = plan({ ...none, issues: [], seen: first.seen })
    expect(unconfirmed.seen).toHaveProperty('PROJ-1')
    const confirmed = plan({ ...none, issues: [], seen: first.seen, left: ['PROJ-1'] })
    expect(confirmed.seen).not.toHaveProperty('PROJ-1')
  })
})
