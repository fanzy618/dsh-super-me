/** The GitLab project a repository's remote names, which is what the API calls need. */
const SCP = /^(?:[^@]+@)?[^:/]+:(.+)$/
const URL = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i

/**
 * Reads `group/project` out of an ssh or https remote, with or without `.git` and with any nesting depth.
 * @returns the project path, or undefined when the remote names none (a local path, an empty value).
 */
export function projectFromRemote(remote: string): string | undefined {
  const value = remote.trim()
  if (!value) return undefined
  const rest = URL.exec(value)?.[1] ?? (value.includes('://') ? undefined : SCP.exec(value)?.[1])
  if (!rest) return undefined
  const project = rest.replace(/\.git$/, '').replace(/\/+$/, '')
  // A project path has at least a group and a name; anything shorter is not one.
  return project.split('/').length >= 2 ? project : undefined
}
