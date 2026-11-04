/** GitLab Source: watches the merge requests a ticket delivers and reads their discussion. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { KV } from '../kv.ts'
import type { SourceKind } from './kind.ts'
import { mrChannel, mrThread, noteTrigger, parseMr, parseNote, SOURCE, type Note } from './gitlab-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'

const Z = z.object({
  cli: z.string().trim().default('glab'),
  pollSeconds: z.number().int().min(60).max(3600).default(120),
  noteLookback: z.number().int().min(1).max(100).default(100),
}).strict()
export type GitlabConfig = z.infer<typeof Z>
const jsonOf = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }
const project = (name: string): string => `projects/${encodeURIComponent(name)}`
/** The merge request, or undefined when the CLI or the answer cannot be read. */
async function readMr(ctx: SourceContext, config: GitlabConfig, name: string, iid: number) {
  const raw = await ctx.commands.runWith(config.cli, ['api', `${project(name)}/merge_requests/${iid}`], {}).then(jsonOf, () => undefined)
  if (!raw || typeof raw !== 'object') return undefined
  return parseMr({ ...raw as Record<string, unknown>, project: name })
}
/** Notes newer than `since`, oldest first. */
async function readNotes(ctx: SourceContext, config: GitlabConfig, name: string, iid: number, since: number): Promise<Note[]> {
  const raw = await ctx.commands.runWith(config.cli, ['api', `${project(name)}/merge_requests/${iid}/notes?sort=asc&per_page=${config.noteLookback}`], {})
    .then(jsonOf, () => undefined)
  if (!Array.isArray(raw)) return []
  return raw.map(item => parseNote(item as Record<string, unknown>)).filter(note => note.id > since).sort((a, b) => a.id - b.id)
}

/** Watches every open ticket's merge requests once, then returns. */
export async function pollRound(ctx: SourceContext): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) { ctx.report('gitlab', health('paused', 'sourceOff')); return }
  for (const ticket of ctx.tickets.open()) {
    const items = (ticket.deliverables ?? []).filter(item => item.project && item.ref)
    for (const item of items) {
      const iid = item.ref!
      const mr = await readMr(ctx, config, item.project, iid)
      if (!mr) continue
      ctx.tickets.record(ticket.id, { ...item, project: mr.project, ref: iid, state: mr.state })
      const thread = { source: SOURCE, id: `${mr.project}!${iid}` }
      if (mr.state === 'open' && !ctx.state.get(KV.gitlab.bound(ticket.id, thread.id))) {
        ctx.tickets.bindThread(ticket.id, thread, true)
        ctx.state.set(KV.gitlab.bound(ticket.id, thread.id), true)
      }
      if (mr.state !== 'open') ctx.tickets.threadClosed(thread, mr.state === 'merged' ? 'merged' : 'closed', new Date().toISOString())
      const cursor = ctx.state.get(KV.gitlab.note(thread.id)) ?? 0
      const notes = await readNotes(ctx, config, mr.project, iid, cursor)
      const mine = notes.filter(note => !note.system && note.author && note.author !== mr.author)
      for (const note of mine) await ctx.receive(noteTrigger(mr, note))
      if (notes.length) ctx.state.set(KV.gitlab.note(thread.id), notes.at(-1)!.id)
    }
  }
  ctx.report('gitlab', { state: 'ready', detail: 'watched', at: new Date().toISOString() })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    try { await pollRound(ctx) }
    catch (error) { if (!signal.aborted) ctx.report('gitlab', { state: 'error', detail: String(error) }) }
    await pause((ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 120) * 1000, signal)
  }
}

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '守望本工单产出的 MR：状态、评论，并在合并或关闭后收尾。', en: 'Watches the merge requests this ticket delivers: their state, their notes, and their close.' },
  schema: Z,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'glab CLI', en: 'glab CLI' }, hint: { zh: '命令名或绝对路径。', en: 'A command name or absolute path.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'noteLookback', type: 'number', advanced: true, min: 1, max: 100, label: { zh: '读取评论条数', en: 'Notes read' } },
  ],
  health: ['gitlab'],
  // This Source never starts work: its triggers reach the tickets already subscribed to the merge request.
  intake: false,
  scope: () => ({ listened: true, observed: false }),
  channel: {
    link: address => ({ url: '', label: { zh: 'MR', en: 'MR' } }),
    send: async () => 'gone',
  },
  find: query => ({ threads: /^[\w.-]+\/[\w.-]+!\d+$/.test(query.trim()) ? [`${SOURCE}:${query.trim()}`] : [], terms: [] }),
  policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9._-]+' }] }],
    explicit: { zh: '名单里的账号在 MR 讨论里发言。', en: 'An account on the list writes on the merge request.' } },
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
