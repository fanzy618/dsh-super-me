/** Jira Source: a sprint query polled through the local `jira` CLI, with comments read back as triggers. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Localized, SourceKind } from './kind.ts'
import { commentTrigger, fingerprint, issueTrigger, jiraChannel, jiraThread, SOURCE, type JiraComment, type JiraIssue } from './jira-trigger.ts'
import { plan, type PendingEntry, type SeenEntry } from './jira-plan.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'

const Z = z.object({
  cli: z.string().trim().default('jira'),
  envFile: z.string().trim().default(''),
  baseUrl: z.string().trim().default(''),
  projects: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  jql: z.string().trim().min(1).default('assignee = currentUser() AND sprint in openSprints() AND statusCategory != Done'),
  pollSeconds: z.number().int().min(60).max(3600).default(300),
  maxTriggersPerRound: z.number().int().min(1).max(100).default(20),
  commentLookback: z.number().int().min(1).max(100).default(50),
}).strict()
export type JiraConfig = z.infer<typeof Z>

/** A row of `issue list --raw`: Jira's list output is trimmed, so it names the issue and its timestamp only. */
const RawRow = z.looseObject({ key: z.string(), fields: z.looseObject({ updated: z.string() }) })
/** Jira's issue as `issue view --raw` returns it, narrowed to the fields this Source reads. */
const RawIssue = z.looseObject({
  key: z.string(),
  self: z.string().optional(),
  fields: z.looseObject({
    summary: z.string(),
    description: z.string().nullish(),
    updated: z.string(),
    status: z.looseObject({ id: z.string(), statusCategory: z.looseObject({ key: z.string() }).nullish() }),
    assignee: z.looseObject({ name: z.string() }).nullish(),
    components: z.array(z.looseObject({ name: z.string() })).default([]),
    labels: z.array(z.string()).default([]),
  }),
})
const CommentBodies = z.looseObject({ fields: z.looseObject({ comment: z.looseObject({ comments: z.array(z.looseObject({ body: z.string().nullish() })).default([]) }) }) })
const RawComment = z.looseObject({ id: z.string(), body: z.string().nullish(), created: z.string(),
  author: z.looseObject({ name: z.string() }).nullish() })

/** Maps one raw issue onto the shape the triggers and the planner use. */
export function parseIssue(raw: z.infer<typeof RawIssue>, baseUrl: string): JiraIssue {
  const { fields } = raw
  const browse = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${raw.key}` : (raw.self ?? '')
  return { key: raw.key, summary: fields.summary, ...fields.description ? { description: fields.description } : {},
    updated: fields.updated, statusId: fields.status.id, ...fields.assignee ? { assignee: fields.assignee.name } : {},
    components: fields.components.map(item => item.name), labels: fields.labels, url: browse }
}
/** Maps one raw comment; the author falls back to an empty id when Jira hides it, never to the agent. */
export function parseComment(raw: z.infer<typeof RawComment>): JiraComment {
  return { id: raw.id, body: raw.body ?? '', author: raw.author?.name ?? '', created: raw.created }
}
/** Reads KEY=VALUE lines from the credential file. Values stay in this process and are never logged. */
export async function credentials(config: JiraConfig): Promise<Record<string, string>> {
  if (!config.envFile) return {}
  try {
    const text = await readFile(config.envFile, 'utf8')
    return Object.fromEntries(text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
      const at = line.indexOf('=')
      return at < 0 ? [line, ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')]
    }))
  } catch (error) { throw new Error(`The Jira credential file ${config.envFile} cannot be read: ${error instanceof Error ? error.message : String(error)}`) }
}
const run = (ctx: SourceContext, config: JiraConfig, env: Record<string, string>, args: string[]): Promise<string> =>
  ctx.commands.runWith(config.cli, args, env)

/** Parses CLI output, or undefined when it is not JSON (a failure the caller treats as incomplete). */
const jsonOf = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }
/** Whether a comment's body carries this message's marker. Jira stores what its wiki converter made of the
 * text, which escapes punctuation, so backslashes are dropped before the token is looked for; the token
 * must stand alone, so that `m-1` does not match `m-10`. */
export const mentions = (body: string, id: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9-])dsh-superagent:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9-]|$)`)
    .test(body.replace(/\\/g, ''))

/** Message ids this process has already posted, by issue; the marker in the body covers a restart. */
const sentTo = new Map<string, Set<string>>()
/** Replies in flight, so two attempts at the same message cannot both pass the check. */
const sending = new Set<string>()
const page = 100
/** Reads every page of the query, then each issue's full record; a short page ends it and any failure makes the round incomplete. */
async function readIssues(ctx: SourceContext, config: JiraConfig, env: Record<string, string>, project: string): Promise<{ issues: JiraIssue[]; complete: boolean }> {
  const rows: { key: string }[] = []
  for (let from = 0; from < page * 50; from += page) {
    const result = await run(ctx, config, env, ['issue', 'list', '-p', project, '-q', config.jql, '--raw', '--paginate', `${from}:${page}`]).catch(() => undefined)
    if (result === undefined) return { issues: [], complete: false }
    const raw = z.array(z.unknown()).safeParse(jsonOf(result))
    if (!raw.success) return { issues: [], complete: false }
    const items = raw.data
    const parsed = items.map(item => RawRow.safeParse(item))
    // Completeness is the size of the page the CLI returned, not the number of rows that parsed.
    if (parsed.some(item => !item.success)) return { issues: [], complete: false }
    rows.push(...parsed.flatMap(item => item.success ? [{ key: item.data.key }] : []))
    if (items.length < page) break
    if (from + page >= page * 50) return { issues: [], complete: false }
  }
  // The list output is trimmed (a status has a name but no id, an assignee has a display name but no
  // login), so each issue is read in full before it becomes a Trigger.
  const issues: JiraIssue[] = []
  for (const row of rows) {
    const raw = await run(ctx, config, env, ['issue', 'view', row.key, '--raw']).then(value => RawIssue.safeParse(jsonOf(value)), () => undefined)
    if (!raw || !raw.success) return { issues: [], complete: false }
    issues.push(parseIssue(raw.data, config.baseUrl))
  }
  return { issues, complete: true }
}
/** True when the issue left the query for a reason the Source can confirm: it is done, or no longer assigned to the operator. */
/** True when the issue left the query for a reason the Source can confirm: done, or no longer assigned to the operator. */
export function departed(issue: z.infer<typeof RawIssue>, login: string): boolean {
  if ((issue.fields.assignee?.name ?? '') !== login) return true
  return issue.fields.status.statusCategory?.key === 'done'
}
/** Reads an issue's comments after the stored cursor and returns the new ones, oldest first. */
async function readComments(ctx: SourceContext, config: JiraConfig, env: Record<string, string>, issue: JiraIssue, cursor: string): Promise<{ comments: JiraComment[]; complete: boolean }> {
  const result = await run(ctx, config, env, ['issue', 'view', issue.key, '--comments', String(config.commentLookback), '--raw']).then(jsonOf, () => undefined)
  const raw = z.looseObject({ fields: z.looseObject({ comment: z.looseObject({ comments: z.array(z.unknown()).default([]) }) }) }).safeParse(result)
  if (!raw.success) return { comments: [], complete: false }
  const parsed = raw.data.fields.comment.comments.map(item => RawComment.safeParse(item))
  if (parsed.some(item => !item.success)) return { comments: [], complete: false }
  const comments = parsed.flatMap(item => item.success ? [parseComment(item.data)] : [])
    .filter(item => Number(item.id) > Number(cursor)).sort((a, b) => Number(a.id) - Number(b.id))
  return { comments, complete: true }
}

/** Runs one polling round; returns false when the round was incomplete and changed nothing. */
export async function pollRound(ctx: SourceContext): Promise<boolean> {
  const config = ctx.config<JiraConfig>(SOURCE)
  if (!config) { ctx.report('jira', health('paused', 'sourceOff')); return true }
  if (!config.projects.length) { ctx.report('jira', health('paused', 'jiraNoProjects')); return true }
  const env = await credentials(config)
  const login = await ctx.commands.runWith(config.cli, ['me'], env).then((value: string) => value.trim(), () => '')
  if (!login) { ctx.report('jira', health('error', 'jiraAuthFailed')); return true }
  let issues: JiraIssue[] = []
  let complete = true
  for (const project of config.projects) {
    const read = await readIssues(ctx, config, env, project)
    issues = [...issues, ...read.issues]
    complete = complete && read.complete
  }
  const seen = ctx.state.get(KV.jira.seen) ?? {}
  const pending = ctx.state.get(KV.jira.pending) ?? []
  // Departures are confirmed one by one; an unconfirmed key stays, so a short list never forgets an issue.
  const present = new Set(issues.map(issue => issue.key))
  const left: string[] = []
  const tracked = new Set([...Object.keys(seen), ...pending.map(item => item.key)])
  if (complete) for (const key of tracked) {
    if (present.has(key)) continue
    const raw = await run(ctx, config, env, ['issue', 'view', key, '--raw']).then(value => RawIssue.safeParse(jsonOf(value)), () => ({ success: false } as const))
    if (raw.success && departed(raw.data, login)) left.push(key)
  }
  const result = plan({ issues, seen, pending, limit: config.maxTriggersPerRound, left, complete })
  for (const issue of result.dispatch) {
    await ctx.receive(issueTrigger(issue))
    ctx.threads.describe(jiraThread(issue.key), { label: `${issue.key} ${issue.summary}`, url: issue.url })
  }
  if (complete) ctx.atomic(() => { ctx.state.set(KV.jira.seen, result.seen); ctx.state.set(KV.jira.pending, result.pending) })
  if (!complete) { ctx.report('jira', health('error', 'jiraPollIncomplete')); return false }
  // Comments: the issues just dispatched, and every issue an open ticket already works on.
  const watched = new Set(result.dispatch.map(issue => issue.key))
  for (const ticket of ctx.tickets.open()) for (const channel of ticket.channels) if (channel.source === SOURCE) watched.add(String(channel.address.issue ?? ''))
  const byKey = new Map(issues.map(issue => [issue.key, issue]))
  // Comments share the round's budget with issues: a burst of replies must not flood an evaluation either.
  let budget = config.maxTriggersPerRound - result.dispatch.length
  let warning: ReturnType<typeof health> | undefined
  for (const issueKey of watched) {
    if (budget <= 0) break
    const issue = byKey.get(issueKey)
    if (!issue) continue
    const cursor = ctx.state.get(KV.jira.comment(issueKey))
    const read = await readComments(ctx, config, env, issue, cursor ?? '0').catch(() => ({ comments: [] as JiraComment[], complete: false }))
    if (!read.complete) { warning = health('error', 'jiraCommentsUnreadable'); continue }
    // The first read records where the issue stands instead of replaying its history at the new ticket.
    if (cursor === undefined) { ctx.state.set(KV.jira.comment(issueKey), read.comments.at(-1)?.id ?? '0'); if (read.comments.length >= config.commentLookback) warning = health('error', 'jiraCommentsTruncated'); continue }
    // A full window means older comments we cannot see; moving the cursor would skip them for good.
    if (read.comments.length >= config.commentLookback) { warning = health('error', 'jiraCommentsTruncated'); continue }
    const fresh = read.comments.filter(comment => comment.author && comment.author !== login).slice(0, budget)
    if (!fresh.length) { ctx.state.set(KV.jira.comment(issueKey), read.comments.at(-1)?.id ?? cursor); continue }
    for (const comment of fresh) await ctx.receive(commentTrigger(issue, comment))
    budget -= fresh.length
    ctx.state.set(KV.jira.comment(issueKey), fresh.at(-1)!.id)
  }
  if (warning) ctx.report('jira', warning)
  else ctx.report('jira', { state: 'ready', detail: `${issues.length} issues; ${result.pending.length} queued`, at: new Date().toISOString() })
  return true
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('jira', health('paused', 'setupPending')); return }
  if (!ctx.config<JiraConfig>(SOURCE)?.cli) { ctx.report('jira', health('paused', 'jiraCliUnset')); return }
  while (!signal.aborted) {
    try { failures = await pollRound(ctx) ? 0 : failures + 1 }
    catch (error) { failures += 1; if (failures >= 3 && !signal.aborted) ctx.report('jira', { state: 'error', detail: String(error) }) }
    await pause((ctx.config<JiraConfig>(SOURCE)?.pollSeconds ?? 300) * 1000, signal)
  }
}

export const jiraKind: SourceKind<JiraConfig> = {
  kind: SOURCE,
  title: { zh: 'Jira', en: 'Jira' },
  description: { zh: '轮询当前 sprint 中指派给操作者的 issue，并读取其评论。', en: 'Polls the issues assigned to the operator in the open sprint and reads their comments.' },
  schema: Z,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'jira CLI', en: 'jira CLI' }, hint: { zh: '命令名或绝对路径；用 jira-cli。', en: 'A command name or absolute path; jira-cli.' } },
    { key: 'envFile', type: 'text', label: { zh: '凭证文件', en: 'Credential file' }, hint: { zh: '在调用 CLI 前导出的文件，含 JIRA_USERNAME 与 JIRA_API_TOKEN；留空则用环境变量。', en: 'Exported before the CLI runs: JIRA_USERNAME and JIRA_API_TOKEN. Empty uses the environment.' } },
    { key: 'projects', type: 'rows', label: { zh: '项目', en: 'Projects' }, columns: [{ key: 'id', type: 'text', label: { zh: '项目 key', en: 'Project key' }, pattern: '[A-Z][A-Z0-9_]*' }] },
    { key: 'jql', type: 'text', label: { zh: 'JQL', en: 'JQL' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'maxTriggersPerRound', type: 'number', advanced: true, min: 1, max: 100, label: { zh: '每轮最多派发', en: 'Triggers per round' } },
    { key: 'commentLookback', type: 'number', advanced: true, min: 1, max: 100, label: { zh: '读取评论条数', en: 'Comments read' } },
  ],
  health: ['jira'],
  scope: () => ({ listened: true, observed: false }),
  channel: {
    // A reply is a comment on the issue. Two things keep a retry from posting twice: the message ids this
    // process already sent, and a marker in the body. A check that cannot run refuses to post rather than
    // guessing, because a duplicate comment is worse than a retry.
    send: async (host, message, config) => {
      const issue = String(message.channel.address.issue ?? '')
      // A key that is not a Jira key cannot be a reply target; treat it as gone rather than passing it to the CLI.
      if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issue)) return 'gone'
      const token = `dsh-superagent:${message.id}`
      const sent = sentTo.get(issue)
      if (sent?.has(message.id)) return 'sent'
      if (sending.has(`${issue}\0${message.id}`)) throw new Error(`${issue} is already being answered`)
      sending.add(`${issue}\0${message.id}`)
      try {
        const env = await credentials(config)
        const comments = await host.commands.runWith(config.cli, ['issue', 'view', issue, '--comments', String(config.commentLookback), '--raw'], env)
          .then(jsonOf)
          .then(value => CommentBodies.safeParse(value))
        // Without a readable list there is no way to know whether the comment exists, so leave it to the retry.
        if (!comments.success) throw new Error(`the comments of ${issue} could not be read, so the reply was not posted`)
        if (comments.data.fields.comment.comments.some(comment => mentions(comment.body ?? '', message.id))) {
          sentTo.get(issue)?.add(message.id) ?? sentTo.set(issue, new Set([message.id]))
          return 'sent'
        }
        try { await host.commands.runWith(config.cli, ['issue', 'comment', 'add', issue, `${message.text}\n\n${token}`, '--no-input'], env) }
        catch (error) {
          // Only the Jira API reporting the issue missing means the target is gone; any other failure may pass.
          if (/unexpected response '40[34]'/i.test(String(error))) return 'gone'
          throw error
        }
        sentTo.get(issue)?.add(message.id) ?? sentTo.set(issue, new Set([message.id]))
        return 'sent'
      } finally { sending.delete(`${issue}\0${message.id}`) }
    },
    link: address => ({ url: String(address.url ?? ''), label: { zh: 'Jira', en: 'Jira' } }),
  },
  find: query => ({ threads: /^[A-Z][A-Z0-9_]*-\d+$/.test(query.trim()) ? [jiraThread(query.trim())] : [], terms: [] }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._@-]+$/), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Jira 账号', en: 'Jira accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9._@-]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的账号被指派这个 issue。', en: 'An account on the list is assigned the issue.' },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_JIRA_ISSUE', description: { zh: '本工单的 Jira issue key，例如 PROJ-123。', en: 'The ticket\'s Jira issue key, such as PROJ-123.' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_JIRA_ISSUE: trigger?.source === SOURCE ? String(trigger.meta.issue ?? '') : '' }),
  },
  facts: (): Record<string, Localized | string> => ({}),
}

export const name = 'dsh-superagent-jira'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(jiraKind), 'jira: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, jiraKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('jira', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
