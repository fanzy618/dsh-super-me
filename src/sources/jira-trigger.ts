/** Normalizes Jira issues and comments into domain Triggers. */
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'jira'
/** One Jira issue as the Source reads it; `description` is truncated before it becomes Trigger text. */
export interface JiraIssue {
  key: string
  summary: string
  description?: string
  /** Jira's own timestamp; not part of the fingerprint, because our own comment moves it. */
  updated: string
  statusId: string
  assignee?: string
  components: string[]
  labels: string[]
  sprintId?: number
  url: string
}
export interface JiraComment { id: string; body: string; author: string; created: string }
export const jiraThread = (issue: string): string => `${SOURCE}:${issue}`
export const jiraChannel = (issue: string, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: jiraThread(issue), address: { issue, ...url ? { url } : {} } })
/** The fields a ticket is about, in a stable order; `updated` is deliberately absent. */
export const fingerprint = (issue: Pick<JiraIssue, 'summary' | 'description' | 'statusId' | 'assignee' | 'components' | 'labels'>): string =>
  key('jira-fingerprint', issue.summary, issue.description ?? '', issue.statusId, issue.assignee ?? '',
    JSON.stringify([...issue.components].sort()), JSON.stringify([...issue.labels].sort()))
const body = (text: string | undefined): string => (text ?? '').slice(0, 8000)

/** Builds the trigger for an issue: an assigned issue is a direct request, so it needs no mention. */
export function issueTrigger(issue: JiraIssue, actor = issue.assignee ?? ''): Trigger {
  return { id: key('jira-issue', issue.key, fingerprint(issue)), source: SOURCE, threads: [{ source: SOURCE, id: issue.key }],
    actor: { source: SOURCE, id: actor }, human: true, addressed: 'direct', at: issue.updated,
    text: `${issue.summary}\n\n${body(issue.description)}`.trim(), url: issue.url, channel: jiraChannel(issue.key, issue.url),
    meta: { issue: issue.key, statusId: issue.statusId, ...issue.sprintId ? { sprintId: issue.sprintId } : {} } }
}
/** Builds the trigger for a comment: a person's message on the issue's thread, which fans out to its ticket. */
export function commentTrigger(issue: JiraIssue, comment: JiraComment): Trigger {
  return { id: key('jira-comment', issue.key, comment.id), source: SOURCE, threads: [{ source: SOURCE, id: issue.key }],
    actor: { source: SOURCE, id: comment.author }, human: true, at: comment.created, text: body(comment.body),
    url: `${issue.url}?focusedCommentId=${comment.id}`, channel: jiraChannel(issue.key, issue.url), meta: { issue: issue.key, commentId: comment.id } }
}
