/** Worktrees for the repositories one ticket works in, named and validated inside one workspace directory. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
export type CheckoutCode = 'invalidName' | 'missing' | 'notDirectory' | 'symlink' | 'outside' | 'protected' | 'busy' | 'gitFailed'
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

/** One path segment: no separators, no `..`, no leading dot, and no case variants of a name. */
const NAME = /^[a-z0-9][a-z0-9._-]*$/
const PROTECTED_FILE = '.dsh-protected'

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)

/** Reads the protected list, ignoring blank lines and comments. */
async function protectedNames(workspace: string, given?: readonly string[]): Promise<Set<string>> {
  if (given) return new Set(given)
  try { return new Set((await readFile(join(workspace, PROTECTED_FILE), 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))) }
  catch { return new Set() }
}

/** Resolves one repository name to a directory inside the workspace, refusing anything a ticket must not reach. */
async function locate(workspace: string, name: string, forbidden: Set<string>): Promise<string> {
  if (!NAME.test(name)) throw new CheckoutError('invalidName', `${name} is not one path segment of the workspace`)
  if (forbidden.has(name)) throw new CheckoutError('protected', `${name} is protected: ${PROTECTED_FILE} names it`)
  const path = join(workspace, name)
  let stats
  try { stats = await lstat(path) } catch { throw new CheckoutError('missing', `${name} is not in the workspace ${workspace}`) }
  if (stats.isSymbolicLink()) throw new CheckoutError('symlink', `${name} is a symbolic link; a ticket checks out directories only`)
  if (!stats.isDirectory()) throw new CheckoutError('notDirectory', `${name} is not a directory`)
  const [root, real] = await Promise.all([realpath(workspace), realpath(path)])
  if (!inside(root, real) || real !== join(root, name)) throw new CheckoutError('outside', `${name} resolves outside the workspace`)
  return real
}

/** Attempts one exclusive lock per repository, removing them again when the call ends. */
async function lock(directory: string, names: readonly string[]): Promise<() => Promise<void>> {
  const held = join(directory, '.checkout')
  await mkdir(held, { recursive: true })
  const taken: string[] = []
  const release = async (): Promise<void> => { await Promise.all(taken.map(file => rm(file, { force: true }))) }
  for (const name of [...names].sort()) {
    const file = join(held, `${name}.lock`)
    try { await writeFile(file, String(process.pid), { flag: 'wx' }); taken.push(file) }
    catch { await release(); throw new CheckoutError('busy', `${name} is already being checked out`) }
  }
  return release
}

/** True when `path` is already the worktree of `repository` on `branch`. */
async function reusable(path: string, branch: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try { return (await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() === branch }
  catch { return false }
}

/** Adds a worktree for one repository, reusing the one a previous call made. */
async function worktree(repository: string, path: string, branch: string): Promise<void> {
  if (await reusable(path, branch)) return
  const existing = await run('git', ['-C', repository, 'rev-parse', '--verify', '--quiet', branch]).then(() => true, () => false)
  const args = existing ? ['-C', repository, 'worktree', 'add', path, branch] : ['-C', repository, 'worktree', 'add', '-b', branch, path]
  try { await run('git', args) }
  catch (error) { throw new CheckoutError('gitFailed', `git worktree add failed for ${repository}: ${error instanceof Error ? error.message : String(error)}`) }
}

/**
 * Checks out each named repository of `workspace` as a worktree under the ticket directory on `branch`.
 * Every name is validated before anything is created, each repository is locked for the duration, and a
 * worktree a previous call made is reused as it stands, including its uncommitted changes.
 * @throws CheckoutError naming the check that refused the request.
 */
export async function checkout(request: CheckoutRequest): Promise<CheckedOut[]> {
  const { workspace, directory, branch, repos } = request
  if (!repos.length) return []
  const forbidden = await protectedNames(workspace, request.protected)
  const roots = await Promise.all(repos.map(name => locate(workspace, name, forbidden)))
  const release = await lock(directory, repos)
  const made: string[] = []
  try {
    const result: CheckedOut[] = []
    for (const [index, name] of repos.entries()) {
      const path = join(directory, name)
      const fresh = !existsSync(path)
      await worktree(roots[index]!, path, branch)
      if (fresh) made.push(path)
      result.push({ name, path })
    }
    return result
  } catch (error) {
    // Nothing half-made: a failed call leaves the ticket directory as it found it.
    for (const path of made) await rm(path, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally { await release() }
}
