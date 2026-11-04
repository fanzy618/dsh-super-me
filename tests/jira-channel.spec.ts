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
    await expect(jiraKind.channel!.send(h, message(), config)).resolves.toBe('sent')
    const add = calls.find(call => call[1] === 'comment')!
    expect(add).toContain('PROJ-1')
    expect(add.join(' ')).toContain('dsh-superagent:m-1')
    expect(add).toContain('--no-input')
  })
  it('does not post a reply that an earlier attempt already posted', async () => {
    const { host: h, calls } = host([comment('900', 'already <sub>dsh-superagent:m-1</sub>')])
    await expect(jiraKind.channel!.send(h, message(), config)).resolves.toBe('sent')
    expect(calls.some(call => call[1] === 'comment')).toBe(false)
  })
  it('reports a gone issue instead of retrying forever', async () => {
    const { host: h } = host([], 'jira: Received unexpected response \'404\'')
    await expect(jiraKind.channel!.send(h, message(), config)).resolves.toBe('gone')
  })
  it('links to the issue it answers on', () => {
    expect(jiraKind.channel!.link({ issue: 'PROJ-1', url: 'https://jira.example/browse/PROJ-1' }, {}))
      .toMatchObject({ url: 'https://jira.example/browse/PROJ-1' })
  })
})

it('routes a reply through the registry to the Jira CLI', async () => {
  const settings = SettingsSchema.parse({ sources: { jira: { enabled: true, config: { cli: 'jira', projects: ['PROJ'] } } } })
  const sources = new SourceRegistry(() => settings)
  sources.register(jiraKind)
  const { host: h, calls } = host()
  await expect(sources.send(message(), h.commands as unknown as Commands)).resolves.toBe('sent')
  expect(calls.some(call => call[1] === 'comment')).toBe(true)
})
