/** Decides which issues one polling round dispatches, and what the round remembers about them. */
import { fingerprint, type JiraIssue } from './jira-trigger.ts'

/** What a previous round recorded about one issue. */
export interface SeenEntry { fingerprint: string; statusId: string; sprintId?: number }
/** An issue waiting for a free dispatch slot; only a dispatched issue leaves the queue. */
export interface PendingEntry { key: string; fingerprint: string }
export interface PlanInput {
  issues: readonly JiraIssue[]
  seen: Readonly<Record<string, SeenEntry>>
  pending: readonly PendingEntry[]
  limit: number
  /** Keys the caller confirmed left the query (Done, reassigned, out of the sprint); dropped only here. */
  left?: readonly string[]
  /** False when a page failed: an incomplete round changes nothing, so it cannot mistake a short list for departures. */
  complete: boolean
}
export interface PlanResult { dispatch: JiraIssue[]; pending: PendingEntry[]; seen: Record<string, SeenEntry> }

/**
 * Plans one round: new or changed issues join the queue, at most `limit` of them dispatch, and the
 * rest stay queued for the next round. Nothing is forgotten unless the caller names it in `left`.
 */
export function plan(input: PlanInput): PlanResult {
  const { issues, seen, limit } = input
  if (!input.complete) return { dispatch: [], pending: [...input.pending], seen: { ...seen } }
  const next: Record<string, SeenEntry> = { ...seen }
  for (const key of input.left ?? []) delete next[key]
  const queue = input.pending.filter(item => !input.left?.includes(item.key)).map(item => ({ ...item }))
  const queued = new Map(queue.map(item => [item.key, item]))
  for (const issue of issues) {
    const current = fingerprint(issue)
    if (next[issue.key]?.fingerprint === current) continue
    const waiting = queued.get(issue.key)
    if (waiting) waiting.fingerprint = current
    else {
      const entry = { key: issue.key, fingerprint: current }
      queue.push(entry); queued.set(issue.key, entry)
    }
  }
  const byKey = new Map(issues.map(issue => [issue.key, issue]))
  const dispatch: JiraIssue[] = []
  const rest: PendingEntry[] = []
  for (const item of queue) {
    const issue = byKey.get(item.key)
    // An issue that left while it waited is dropped from the queue, not dispatched.
    if (!issue || fingerprint(issue) !== item.fingerprint) continue
    if (dispatch.length < limit) dispatch.push(issue)
    else rest.push(item)
  }
  for (const issue of dispatch) next[issue.key] = { fingerprint: fingerprint(issue), statusId: issue.statusId, ...issue.sprintId ? { sprintId: issue.sprintId } : {} }
  return { dispatch, pending: rest, seen: next }
}
