import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
