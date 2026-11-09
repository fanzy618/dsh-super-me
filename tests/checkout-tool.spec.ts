import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { feishu } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
vi.setConfig({ testTimeout: 30_000 })
let h: Host
let dir: string
let workspace: string
let ticketDir: string

/** A workspace with one initialized git repository, seeded into the runtime's Execution settings. */
const start = async (): Promise<Host> => startRuntime(store => {
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, workspace } })
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'checkout-tool-'))
  workspace = join(dir, 'workspace')
  ticketDir = join(dir, 'ticket')
  mkdirSync(join(workspace, 'console'), { recursive: true })
  mkdirSync(ticketDir, { recursive: true })
  await exec('git', ['init', '-q', join(workspace, 'console')], { env: gitEnv() })
  await exec('git', ['-C', join(workspace, 'console'), 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv() })
  h = await start()
})
afterEach(async () => { await h.stop(); rmSync(dir, { recursive: true, force: true }) })

/** Gives a ticket the directory the executor sets once an assignment starts. */
const withDirectory = (host: Host, ticketId: string): void => {
  host.runtime.store.atomic(() => {
    const ticket = host.runtime.store.tickets.get(ticketId)!
    host.runtime.store.tickets.save({ ...ticket, execution: { name: 'fix-regression', directory: ticketDir, assignment: 'go' } })
  })
}

it('checks out the repositories it is asked for and records them on the ticket', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  withDirectory(h, ticket.id)
  const result = await h.runTool(sessionId, 'orchestrator_checkout', { repos: ['console'] })
  expect(result).toEqual({ repos: [{ name: 'console', path: join(ticketDir, 'console') }] })
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after.repos).toEqual(['console'])
  expect(after.deliverables).toEqual([{ repo: 'console', project: '', kind: 'mr', state: 'pending' }])
})

it('records a repository once when the agent checks it out twice', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  withDirectory(h, ticket.id)
  await h.runTool(sessionId, 'orchestrator_checkout', { repos: ['console'] })
  await h.runTool(sessionId, 'orchestrator_checkout', { repos: ['console'] })
  expect(h.runtime.store.tickets.get(ticket.id)!.deliverables).toHaveLength(1)
})

it('refuses names that are not one workspace directory', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  withDirectory(h, ticket.id)
  await expect(h.runTool(sessionId, 'orchestrator_checkout', { repos: ['../console'] })).rejects.toThrow()
  await expect(h.runTool(sessionId, 'orchestrator_checkout', { repos: ['missing'] })).rejects.toThrow(/missing/)
  expect(h.runtime.store.tickets.get(ticket.id)!.repos ?? []).toEqual([])
})
