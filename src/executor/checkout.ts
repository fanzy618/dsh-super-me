/** Worktrees for the repositories one ticket works in, named and validated inside one workspace directory. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
/** Git runs under a deadline and never prompts: a hung or credential-seeking command must fail the call, not hold the tool. */
const git = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
  run('git', args, { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
export type CheckoutCode = 'invalidName' | 'invalidBranch' | 'invalidDirectory' | 'missing' | 'notDirectory' | 'symlink' | 'outside' | 'protected' | 'busy' | 'gitFailed'
/** A refused checkout; `code` names the check that failed. */
export class CheckoutError extends Error {
  constructor(readonly code: CheckoutCode, message: string) { super(message); this.name = 'CheckoutError' }
}
export interface CheckoutRequest {
  /** The workspace: a directory of repositories, one per subdirectory. */
  workspace: string
  /** The ticket's own directory, which receives one worktree per repository. */
  directory: string
  /** The ticket branch, `agent/<ticket-short-name>`. */
  branch: string
  repos: readonly string[]
  /** Names in `<workspace>/.dsh-protected`, one per line, that no ticket may check out. */
  protected?: readonly string[]
}
export interface CheckedOut { name: string; path: string }

/** One path segment: no separators, no `..`, and no leading dot. Uppercase names are ordinary repository names here. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PROTECTED_FILE = '.dsh-protected'
/** A lock older than this is taken over: the process that made it is gone or wedged. */
const STALE_LOCK_MS = 30 * 60_000

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)
const same = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/** Reads the protected list, ignoring blank lines and comments. A list that exists but cannot be read fails closed. */
async function protectedNames(workspace: string, given?: readonly string[]): Promise<Set<string>> {
  if (given !== undefined) return new Set(given.map(name => name.trim()).filter(Boolean))
  try { return new Set((await readFile(join(workspace, PROTECTED_FILE), 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw new CheckoutError('protected', `${PROTECTED_FILE} exists but cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Resolves one repository name to a directory inside the workspace, refusing anything a ticket must not reach. */
async function locate(workspace: string, name: string, forbidden: Set<string>): Promise<string> {
  if (!NAME.test(name)) throw new CheckoutError('invalidName', `${name} is not one path segment of the workspace`)
  if (forbidden.has(name)) throw new CheckoutError('protected', `${name} is protected: ${PROTECTED_FILE} names it`)
  const path = join(workspace, name)
  let stats
  try { stats = await lstat(path) } catch {
    throw new CheckoutError('missing', `${name} is not in the workspace ${workspace}; ask the operator which repositories belong there instead of working outside it`)
  }
  if (stats.isSymbolicLink()) throw new CheckoutError('symlink', `${name} is a symbolic link; a ticket checks out directories only`)
  if (!stats.isDirectory()) throw new CheckoutError('notDirectory', `${name} is not a directory`)
  const [root, real] = await Promise.all([realpath(workspace), realpath(path)])
  if (!inside(root, real) || !same(real, join(root, name))) throw new CheckoutError('outside', `${name} resolves outside the workspace`)
  return real
}

/** A ticket branch: `agent/<name>` and a ref name git accepts, so it never reads as an option or another revision. */
async function assertBranch(branch: string): Promise<void> {
  if (!branch.startsWith('agent/') || branch.length <= 'agent/'.length) throw new CheckoutError('invalidBranch', `${branch} is not an agent/<name> branch`)
  await git(['check-ref-format', '--branch', branch]).catch(() => { throw new CheckoutError('invalidBranch', `${branch} is not a valid branch name`) })
}

/** The ticket directory itself, resolved and checked: a checkout must not be steered outside it by a link. */
async function ticketDirectory(directory: string): Promise<string> {
  let stats
  try { stats = await lstat(directory) } catch { throw new CheckoutError('invalidDirectory', `the ticket directory ${directory} does not exist`) }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new CheckoutError('invalidDirectory', `the ticket directory ${directory} is not a plain directory`)
  return realpath(directory)
}

/** Whether the process that wrote a lock file is still alive; only a lock whose process is gone can be taken over. */
async function staleLock(file: string): Promise<boolean> {
  try {
    const [pid, written] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    const owner = Number(pid.trim())
    if (!Number.isInteger(owner) || owner <= 0) return Date.now() - written.mtimeMs >= STALE_LOCK_MS
    try { process.kill(owner, 0); return false } catch { return true }
  } catch { return false }
}

/** Attempts one exclusive lock per repository, removing them again when the call ends. */
async function lock(directory: string, names: readonly string[]): Promise<() => Promise<void>> {
  const held = join(directory, '.checkout')
  await mkdir(held, { recursive: true })
  const taken: string[] = []
  const release = async (): Promise<void> => { await Promise.all(taken.map(file => rm(file, { force: true }))) }
  for (const name of names) {
    const file = join(held, `${name}.lock`)
    try { await writeFile(file, String(process.pid), { flag: 'wx' }); taken.push(file) }
    catch {
      if (await staleLock(file)) { await rm(file, { force: true }); try { await writeFile(file, String(process.pid), { flag: 'wx' }); taken.push(file); continue } catch { /* Taken meanwhile. */ } }
      await release(); throw new CheckoutError('busy', `${name} is already being checked out`)
    }
  }
  return release
}

/** True when `path` is already this repository's worktree on `branch`, so a previous call's work, including uncommitted changes, is kept. */
async function reusable(repository: string, path: string, branch: string): Promise<boolean> {
  let stats
  try { stats = await lstat(path) } catch { return false }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false
  try {
    const [head, top, common] = await Promise.all([
      git(['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']).then(result => result.stdout.trim()),
      git(['-C', path, 'rev-parse', '--show-toplevel']).then(result => result.stdout.trim()),
      git(['-C', path, 'rev-parse', '--git-common-dir']).then(result => result.stdout.trim()),
    ])
    // The directory must belong to this workspace repository, not merely sit where its worktree would.
    const commonDir = isAbsolute(common) ? common : join(path, common)
    return head === branch && same(await realpath(top), await realpath(path)) && same(await realpath(commonDir), await realpath(join(repository, '.git')))
  } catch { return false }
}

/** Adds a worktree for one repository, reusing the one a previous call made. Reports whether it created the branch. */
async function worktree(repository: string, path: string, branch: string): Promise<{ branch: boolean }> {
  if (await reusable(repository, path, branch)) return { branch: false }
  const existing = await git(['-C', repository, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
  const args = existing ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path]
  try { await git(['-C', repository, '-c', 'core.hooksPath=/dev/null', ...args]) }
  catch (error) { throw new CheckoutError('gitFailed', `git worktree add failed for ${repository}: ${error instanceof Error ? error.message : String(error)}`) }
  return { branch: !existing }
}

/**
 * Checks out each named repository of `workspace` as a worktree under the ticket directory on `branch`.
 * Every name is validated before anything is created, each repository is locked for the duration, and a
 * worktree a previous call made is reused as it stands, including its uncommitted changes.
 * @throws CheckoutError naming the check that refused the request.
 */
export async function checkout(request: CheckoutRequest): Promise<CheckedOut[]> {
  const { workspace, directory, branch } = request
  const repos = [...new Set(request.repos)]
  if (!repos.length) return []
  await assertBranch(branch)
  const root = await ticketDirectory(directory)
  const forbidden = await protectedNames(workspace, request.protected)
  const roots = await Promise.all(repos.map(name => locate(workspace, name, forbidden)))
  const release = await lock(root, repos)
  const attempted: { repository: string; path: string; fresh: boolean; createdBranch: boolean }[] = []
  try {
    const result: CheckedOut[] = []
    for (const [index, name] of repos.entries()) {
      const path = join(root, name)
      const fresh = !existsSync(path)
      const { branch: createdBranch } = await worktree(roots[index]!, path, branch)
      attempted.push({ repository: roots[index]!, path, fresh, createdBranch })
      result.push({ name, path })
    }
    return result
  } catch (error) {
    // Leave nothing half-made: remove through git whatever this call put in the ticket directory, so no
    // worktree metadata or branch outlives the failure and a retry starts clean.
    for (const item of attempted.reverse()) {
      if (!item.fresh || !existsSync(item.path)) continue
      await git(['-C', item.repository, 'worktree', 'remove', '--force', item.path]).catch(() => {})
      if (item.createdBranch) await git(['-C', item.repository, 'branch', '-D', '--', branch]).catch(() => {})
    }
    throw error
  } finally { await release() }
}
