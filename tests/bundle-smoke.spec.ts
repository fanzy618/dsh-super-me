import { describe, expect, it } from 'vitest'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { readFileSync } from 'node:fs'
import { githubKind } from '../src/sources/github.ts'
import { jiraKind } from '../src/sources/jira.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'

const registry = () => {
  const sources = new SourceRegistry(() => SettingsSchema.parse({}))
  sources.register(githubKind); sources.register(jiraKind); sources.register(gitlabKind)
  return sources
}

describe('the bundle as it is assembled', () => {
  it('registers the three sources a v1 installation can use', () => {
    const sources = registry()
    expect(sources.instances().map(item => item.kind).sort()).toEqual(['github', 'gitlab', 'jira'])
  })
  it('lets Jira start work and keeps GitLab from ever starting it', () => {
    const sources = registry()
    expect(sources.intake('jira')).toBe(true)
    expect(sources.intake('gitlab')).toBe(false)
  })
  it('ships both new Sources in the bundle, off until an operator turns them on', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(/- id: dsh-superagent-jira\n\s+name: dsh-superagent\/jira-watch\n\s+disabled: true/)
    expect(patch).toMatch(/- id: dsh-superagent-gitlab\n\s+name: dsh-superagent\/gitlab-watch\n\s+disabled: true/)
  })
  it('gives every source a form and its own health entries', () => {
    const sources = registry()
    for (const kind of [githubKind, jiraKind, gitlabKind]) {
      expect(kind.fields.length).toBeGreaterThan(0)
      expect(kind.health.length).toBeGreaterThan(0)
      expect(sources.healthEntries(kind.health).size).toBe(kind.health.length)
      for (const name of kind.health) expect(sources.healthEntries([name]).has(name)).toBe(true)
    }
  })
  it('parses each source part of the policy from an empty document', () => {
    const sources = registry()
    for (const kind of ['jira', 'gitlab'] as const) {
      expect(sources.policyPart(kind)).toMatchObject({ allowed: [] })
    }
  })
  it('publishes the environment variables a worker needs for each source', () => {
    const sources = registry()
    const keys = sources.declarations().flatMap(item => item.variables.map(variable => variable.key))
    expect(keys).toEqual(expect.arrayContaining(['DSH_SUPERAGENT_JIRA_ISSUE', 'DSH_SUPERAGENT_GITHUB_REPOSITORY']))
  })
})
