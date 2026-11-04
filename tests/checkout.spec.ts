import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckoutError, checkout } from '../src/executor/checkout.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let workspace: string
let ticketDir: string

/** A workspace directory with the repositories `repos`, each an initialized git repository. */
const workspaceWith = async (repos: string[]): Promise<void> => {
  for (const name of repos) {
    const path = join(workspace, name)
    mkdirSync(path, { recursive: true })
    await exec('git', ['init', '-q', path], { env: gitEnv() })
    await exec('git', ['-C', path, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv() })
  }
}
const request = (repos: string[], overrides: Partial<Parameters<typeof checkout>[0]> = {}) =>
  ({ workspace, directory: ticketDir, branch: 'agent/brave-otter', repos, ...overrides })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checkout-'))
  workspace = join(dir, 'workspace')
  ticketDir = join(dir, 'ticket')
  mkdirSync(workspace)
  mkdirSync(ticketDir)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('repository names', () => {
  it('accepts one path segment and refuses anything that could leave the workspace', async () => {
    await workspaceWith(['console'])
    await expect(checkout(request(['../console']))).rejects.toMatchObject({ code: 'invalidName' })
    await expect(checkout(request(['/etc']))).rejects.toMatchObject({ code: 'invalidName' })
    await expect(checkout(request(['a/b']))).rejects.toMatchObject({ code: 'invalidName' })
    await expect(checkout(request(['.hidden']))).rejects.toMatchObject({ code: 'invalidName' })
    await expect(checkout(request(['console']))).resolves.toEqual([{ name: 'console', path: join(ticketDir, 'console') }])
  })
  it('names a repository the workspace does not have', async () => {
    await expect(checkout(request(['missing']))).rejects.toMatchObject({ code: 'missing' })
  })
  it('refuses a symbolic link inside the workspace, even to a directory', async () => {
    mkdirSync(join(dir, 'outside')); symlinkSync(join(dir, 'outside'), join(workspace, 'linked'))
    await expect(checkout(request(['linked']))).rejects.toMatchObject({ code: 'symlink' })
  })
  it('refuses a repository on the protected list', async () => {
    await workspaceWith(['console', 'platform'])
    writeFileSync(join(workspace, '.dsh-protected'), 'platform\n')
    await expect(checkout(request(['platform']))).rejects.toMatchObject({ code: 'protected' })
    await expect(checkout(request(['console']))).resolves.toHaveLength(1)
  })
})

describe('worktrees', () => {
  it('creates one worktree per repository on the ticket branch', async () => {
    await workspaceWith(['console', 'backend'])
    const result = await checkout(request(['console', 'backend']))
    expect(result.map(item => item.name)).toEqual(['console', 'backend'])
    for (const name of ['console', 'backend']) {
      const branch = (await exec('git', ['-C', join(ticketDir, name), 'rev-parse', '--abbrev-ref', 'HEAD'], { env: gitEnv() })).stdout.trim()
      expect(branch).toBe('agent/brave-otter')
    }
  })
  it('reuses the worktree it already made instead of failing or resetting it', async () => {
    await workspaceWith(['console'])
    await checkout(request(['console']))
    writeFileSync(join(ticketDir, 'console', 'work.txt'), 'uncommitted')
    await expect(checkout(request(['console']))).resolves.toEqual([{ name: 'console', path: join(ticketDir, 'console') }])
    expect((await exec('git', ['-C', join(ticketDir, 'console'), 'status', '--porcelain'], { env: gitEnv() })).stdout).toContain('work.txt')
  })
  it('reports a repository that another call is checking out', async () => {
    await workspaceWith(['console'])
    mkdirSync(join(ticketDir, '.checkout'), { recursive: true })
    writeFileSync(join(ticketDir, '.checkout', 'console.lock'), String(process.pid))
    await expect(checkout(request(['console']))).rejects.toMatchObject({ code: 'busy' })
  })
  it('creates nothing when any repository fails validation', async () => {
    await workspaceWith(['console'])
    await expect(checkout(request(['console', 'missing']))).rejects.toMatchObject({ code: 'missing' })
    expect(existsSync(join(ticketDir, 'console'))).toBe(false)
  })
})

describe('reuse and failure', () => {
  it('accepts uppercase repository names and checks each name out once', async () => {
    await workspaceWith(['Console'])
    await expect(checkout(request(['Console', 'Console']))).resolves.toEqual([{ name: 'Console', path: join(ticketDir, 'Console') }])
  })
  it('does not reuse a directory that is a different repository on the same branch', async () => {
    await workspaceWith(['console'])
    const stranger = join(ticketDir, 'console')
    mkdirSync(stranger)
    await exec('git', ['init', '-q', stranger], { env: gitEnv() })
    await exec('git', ['-C', stranger, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv() })
    await exec('git', ['-C', stranger, 'checkout', '-q', '-b', 'agent/brave-otter'], { env: gitEnv() })
    await expect(checkout(request(['console']))).rejects.toMatchObject({ code: 'gitFailed' })
  })
  it('takes over a lock whose process is gone', async () => {
    await workspaceWith(['console'])
    mkdirSync(join(ticketDir, '.checkout'), { recursive: true })
    writeFileSync(join(ticketDir, '.checkout', 'console.lock'), '999999')
    await expect(checkout(request(['console']))).resolves.toHaveLength(1)
  })
  it('fails closed when the protected list cannot be read', async () => {
    await workspaceWith(['console'])
    const file = join(workspace, '.dsh-protected')
    writeFileSync(file, 'platform\n')
    chmodSync(file, 0o000)
    await expect(checkout(request(['console']))).rejects.toMatchObject({ code: 'protected' })
    chmodSync(file, 0o644)
  })
  it('removes the worktrees it created when a later repository fails, and succeeds on a retry', async () => {
    await workspaceWith(['console', 'backend'])
    mkdirSync(join(ticketDir, 'backend'))
    writeFileSync(join(ticketDir, 'backend', 'in-the-way'), 'x')
    await expect(checkout(request(['console', 'backend']))).rejects.toMatchObject({ code: 'gitFailed' })
    expect(existsSync(join(ticketDir, 'console', '.git'))).toBe(false)
    rmSync(join(ticketDir, 'backend'), { recursive: true, force: true })
    await expect(checkout(request(['console', 'backend']))).resolves.toHaveLength(2)
  })
})

describe('inputs a ticket must not control', () => {
  it('refuses a branch that is not an agent/<name> ref', async () => {
    await workspaceWith(['console'])
    await expect(checkout(request(['console'], { branch: '-x' }))).rejects.toMatchObject({ code: 'invalidBranch' })
    await expect(checkout(request(['console'], { branch: 'agent/' }))).rejects.toMatchObject({ code: 'invalidBranch' })
    await expect(checkout(request(['console'], { branch: 'refs/heads/agent/x' }))).rejects.toMatchObject({ code: 'invalidBranch' })
    expect(existsSync(join(ticketDir, 'console'))).toBe(false)
  })
  it('refuses a ticket directory that is a symbolic link', async () => {
    await workspaceWith(['console'])
    const real = join(dir, 'real-ticket'); mkdirSync(real); symlinkSync(real, join(dir, 'linked-ticket'))
    await expect(checkout(request(['console'], { directory: join(dir, 'linked-ticket') }))).rejects.toMatchObject({ code: 'invalidDirectory' })
  })
  it('does not take over a lock whose process is alive, however old', async () => {
    await workspaceWith(['console'])
    const lock = join(ticketDir, '.checkout'); mkdirSync(lock, { recursive: true })
    const file = join(lock, 'console.lock'); writeFileSync(file, String(process.pid))
    const old = new Date(Date.now() - 31 * 60_000); utimesSync(file, old, old)
    await expect(checkout(request(['console']))).rejects.toMatchObject({ code: 'busy' })
  })
})
