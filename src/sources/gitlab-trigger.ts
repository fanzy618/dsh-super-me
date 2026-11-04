/** Merge requests and their notes as domain Triggers. */
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'gitlab'
export interface Mr {
  project: string
  iid: number
  title: string
  state: 'open' | 'merged' | 'closed'
  webUrl: string
  sourceBranch: string
  author: string
  headSha: string
}
export interface Note { id: number; body: string; created: string; author: string; system: boolean }
/** GitLab's own state names, mapped onto the ones a deliverable records. */
const STATE: Record<string, Mr['state']> = { opened: 'open', merged: 'merged', closed: 'closed' }
/** One `merge_requests/:iid` answer, narrowed to what a deliverable and a thread need. */
export const parseMr = (raw: Record<string, unknown>): Mr => ({
  project: typeof raw.project === 'string' ? raw.project : '',
  iid: Number(raw.iid),
  title: String(raw.title ?? ''),
  state: STATE[String(raw.state)] ?? 'open',
  webUrl: String(raw.web_url ?? ''),
  sourceBranch: String(raw.source_branch ?? ''),
  author: String((raw.author as { username?: string } | undefined)?.username ?? ''),
  headSha: String(raw.sha ?? ''),
})
/** One note as GitLab returns it; `system` marks a note nobody wrote. */
export const parseNote = (raw: Record<string, unknown>, fallbackAuthor = ''): Note => ({
  id: Number(raw.id),
  body: String(raw.body ?? ''),
  created: String(raw.created_at ?? ''),
  author: String((raw.author as { username?: string } | undefined)?.username ?? fallbackAuthor),
  system: raw.system === true,
})
/** The thread a merge request owns; the project is part of it so two projects cannot collide. */
export const mrThread = (project: string, iid: number): string => `${SOURCE}:${project}!${iid}`
export const mrChannel = (project: string, iid: number): ChannelRef =>
  ({ source: SOURCE, thread: `${project}!${iid}`, address: { project, iid: String(iid) } })
/** Builds the trigger for a note on a merge request; a system note is context, never a request. */
export function noteTrigger(mr: Mr, note: Note): Trigger {
  return { id: key('gitlab-note', mr.project, String(mr.iid), String(note.id)), source: SOURCE,
    threads: [{ source: SOURCE, id: `${mr.project}!${mr.iid}` }], actor: { source: SOURCE, id: note.author },
    human: !note.system, at: note.created, text: note.body.slice(0, 8000),
    url: `${mr.webUrl}#note_${note.id}`, channel: mrChannel(mr.project, mr.iid),
    meta: { project: mr.project, iid: mr.iid, noteId: note.id } }
}
