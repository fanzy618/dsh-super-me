import { describe, expect, it } from 'vitest'
import { jiraKind, type JiraConfig } from '../src/sources/jira.ts'
import { jiraChannel } from '../src/sources/jira-trigger.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Commands } from '../src/infra/commands.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'

const config: JiraConfig = { cli: 'jira', envFile: '', baseUrl: 'https://jira.example', projects: ['PROJ'], jql: 'x',
  pollSeconds: 300, maxTriggersPerRound: 20, commentLookback: 50 } as JiraConfig
const message = (id = 'm-1', text = 'Done: opened PROJ-2'): OutboundMessage =>
  ({ id, channel: jiraChannel('PROJ-1', 'https://jira.example/browse/PROJ-1'), text, kind: 'reply' })

/** A CLI stand-in that records the calls it receives and answers comments with `existing`. */
const host = (existing: unknown[] = [], addFails = '') => {
  const calls: string[][] = []
  const runWith = async (_program: string, args: string[]): Promise<string> => {
    calls.push(args)
    if (args[1] === 'view') return JSON.stringify({ fields: { comment: { comments: existing } } })
    if (args[1] === 'comment') {
      if (addFails) throw new Error(addFails)
      return '{}'
    }
    return ''
  }
  return { host: { commands: { runWith } } as unknown as Pick<SourceContext, 'commands'>, calls }
}
const comment = (id: string, body: string) => ({ id, body, created: '2026-01-01T00:00:00.000+0000', author: { name: 'bob' } })

describe('the Jira Channel', () => {
  it('posts a reply once with a marker that makes it idempotent', async () => {
    const { host: h, calls } = host()
    await expect(jiraKind.channel!.send(h, message('first-1'), config)).resolves.toBe('sent')
    const add = calls.find(call => call[1] === 'comment')!
    expect(add).toContain('PROJ-1')
    expect(add.join(' ')).toContain('dsh-superagent:first-1')
    expect(add).toContain('--no-input')
  })
  it('does not post a reply that an earlier attempt already posted', async () => {
    const { host: h, calls } = host([comment('900', 'already posted\n\ndsh\\-superagent:dup-1')])
    await expect(jiraKind.channel!.send(h, message('dup-1'), config)).resolves.toBe('sent')
    expect(calls.some(call => call[1] === 'comment')).toBe(false)
  })
  it('reports a gone issue instead of retrying forever', async () => {
    const { host: h } = host([], "jira: Received unexpected response '404'")
    await expect(jiraKind.channel!.send(h, message('gone-1'), config)).resolves.toBe('gone')
  })
  it('does not treat every error that mentions a missing command as a gone issue', async () => {
    const { host: h } = host([], 'sh: jira: command not found')
    await expect(jiraKind.channel!.send(h, message('cmd-1'), config)).rejects.toThrow()
  })
  it('refuses to post when it cannot read the comments that would prove the reply is absent', async () => {
    const calls: string[][] = []
    const failing = { commands: { runWith: async (_program: string, args: string[]) => { calls.push(args); throw new Error('jira: 502') } } }
    await expect(jiraKind.channel!.send(failing as never, message('read-1'), config)).rejects.toThrow()
    expect(calls.some(call => call[1] === 'comment')).toBe(false)
  })
  it('does not mistake a longer message id for the one it is looking for', async () => {
    const { host: h, calls } = host([comment('900', 'already dsh\\-superagent:long-10')])
    await expect(jiraKind.channel!.send(h, message('long-1'), config)).resolves.toBe('sent')
    expect(calls.some(call => call[1] === 'comment')).toBe(true)
  })
  it('refuses an address that is not a Jira key', async () => {
    const { host: h, calls } = host()
    const odd = { ...message('odd-1'), channel: { ...jiraChannel('PROJ-1'), address: { issue: '--help' } } }
    await expect(jiraKind.channel!.send(h, odd, config)).resolves.toBe('gone')
    expect(calls).toEqual([])
  })
  it('does not send again for a message this process already posted', async () => {
    const { host: h, calls } = host()
    await jiraKind.channel!.send(h, message('m-9'), config)
    await jiraKind.channel!.send(h, message('m-9'), config)
    expect(calls.filter(call => call[1] === 'comment')).toHaveLength(1)
  })
  it('links to the issue it answers on', () => {
    expect(jiraKind.channel!.link({ issue: 'PROJ-1', url: 'https://jira.example/browse/PROJ-1' }, {}))
      .toMatchObject({ url: 'https://jira.example/browse/PROJ-1' })
  })
})

it('leaves a reply waiting while its Source is off', async () => {
  const settings = SettingsSchema.parse({ sources: { jira: { enabled: false, config: { cli: 'jira', projects: ['PROJ'] } } } })
  const sources = new SourceRegistry(() => settings)
  sources.register(jiraKind)
  const { host: h, calls } = host()
  await expect(sources.send(message('off-1'), h.commands as unknown as Commands)).resolves.toBe('waiting')
  expect(calls).toEqual([])
})
it('routes a reply through the registry to the Jira CLI', async () => {
  const settings = SettingsSchema.parse({ sources: { jira: { enabled: true, config: { cli: 'jira', projects: ['PROJ'] } } } })
  const sources = new SourceRegistry(() => settings)
  sources.register(jiraKind)
  const { host: h, calls } = host()
  await expect(sources.send(message('route-1'), h.commands as unknown as Commands)).resolves.toBe('sent')
  expect(calls.some(call => call[1] === 'comment')).toBe(true)
})
