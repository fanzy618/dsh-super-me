/** What a ticket delivers, and when its deliverables are all finished. */
import type { Deliverable } from './model.ts'

/**
 * Whether the ticket's deliverables are done: every repository it works in has one, none is still
 * waiting for or in a merge request, and no delivery failed. `merged` only when every merge request
 * merged; `closed` when one of them closed without merging.
 * @param deliverables - The ticket's recorded deliverables.
 * @param repos - The repositories the ticket checked out, whose deliverables must all exist.
 */
export function summarise(deliverables: readonly Deliverable[], repos: readonly string[] = []): 'merged' | 'closed' | undefined {
  const byRepo = new Map(deliverables.map(item => [item.repo, item]))
  if (repos.some(repo => !byRepo.has(repo))) return undefined
  if (!deliverables.length) return undefined
  if (deliverables.some(item => item.state === 'pending' || item.state === 'failed' || item.state === 'open')) return undefined
  return deliverables.every(item => item.state === 'merged') ? 'merged' : 'closed'
}
