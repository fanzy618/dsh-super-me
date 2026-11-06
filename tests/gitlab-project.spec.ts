import { describe, expect, it } from 'vitest'
import { projectFromRemote } from '../src/sources/gitlab-project.ts'

describe('a repository remote', () => {
  it('reads the project path from an ssh remote', () => {
    expect(projectFromRemote('git@gitlab-ce.alauda.cn:acp/console.git')).toBe('acp/console')
    expect(projectFromRemote('ssh://git@gitlab.example:2222/acp/team/console.git')).toBe('acp/team/console')
  })
  it('reads it from an https remote', () => {
    expect(projectFromRemote('https://gitlab.example/acp/console.git')).toBe('acp/console')
    expect(projectFromRemote('https://gitlab.example/acp/team/console')).toBe('acp/team/console')
  })
  it('refuses a remote that names no project', () => {
    expect(projectFromRemote('')).toBeUndefined()
    expect(projectFromRemote('not a url')).toBeUndefined()
  })
})
