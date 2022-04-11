import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ConfigError, checkProject, resolveWithin } from '../src/index.mjs'
import { CONFIG_NAME, catalogJson, configJson, runCli } from './helpers.mjs'

const SECRET = 'OUT-OF-ROOT-CONTENT-THAT-MUST-NEVER-REACH-A-REPORT'

/**
 * A site directory with a sibling directory outside it. The outside directory
 * holds a catalog the configuration has no right to name: if it were ever read,
 * its keys would surface in the report as `extra-key` findings carrying the
 * value as evidence.
 */
async function makeSite(t, locales) {
  const parent = await mkdtemp(join(tmpdir(), 'locale-fallback-confinement-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const site = join(parent, 'site')
  const outside = join(parent, 'outside')
  await mkdir(join(site, 'locales'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.json'), catalogJson({ 'leaked.key': SECRET }))
  await writeFile(join(site, 'locales', 'en.json'), catalogJson({ legal: { terms: 'Accept.' } }))
  await writeFile(join(site, 'locales', 'pt.json'), catalogJson({ legal: { terms: 'Aceite.' } }))
  await writeFile(join(site, CONFIG_NAME), configJson({
    sourceLocale: 'en',
    locales,
    requiredKeyPrefixes: ['legal'],
  }))
  return { parent, site, outside, config: join(site, CONFIG_NAME) }
}

const INSIDE = [
  { id: 'en', catalog: 'locales/en.json', fallback: [] },
  { id: 'pt', catalog: 'locales/pt.json', fallback: ['en'] },
]

async function refusal(t, locales) {
  const site = await makeSite(t, locales)
  const error = await checkProject({ config: site.config }).then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true, 'expected a ConfigError')
  assert.equal(error.message.includes(SECRET), false, 'the refusal echoed out-of-root content')
  return { site, error }
}

test('a lexical escape from the input root is refused', async (t) => {
  const { error } = await refusal(t, [
    { id: 'en', catalog: '../outside/secret.json', fallback: [] },
  ])
  assert.equal(error.rule, 'input-outside-root')
})

test('an absolute catalog path is refused', async (t) => {
  const { error } = await refusal(t, [{ id: 'en', catalog: '/etc/hosts', fallback: [] }])
  assert.equal(error.rule, 'input-not-relative')
})

test('a symbolic link to a file outside the root is refused after resolution', async (t) => {
  const site = await makeSite(t, [{ id: 'en', catalog: 'locales/linked.json', fallback: [] }])
  await symlink(join(site.outside, 'secret.json'), join(site.site, 'locales', 'linked.json'))

  const error = await checkProject({ config: site.config }).then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.equal(error.rule, 'input-escapes-root')
  assert.equal(error.message.includes(SECRET), false)

  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '', 'a configuration refusal must leave stdout empty')
  assert.equal(run.stderr.includes(SECRET), false)
  assert.match(run.stderr, /symbolic link/u)
})

test('a symbolic link to a directory outside the root is refused after resolution', async (t) => {
  const site = await makeSite(t, [{ id: 'en', catalog: 'locales/away/secret.json', fallback: [] }])
  await symlink(site.outside, join(site.site, 'locales', 'away'))

  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.includes(SECRET), false)
  assert.match(run.stderr, /input root/u)
})

test('a relative path that stays inside the root is allowed', async (t) => {
  const site = await makeSite(t, [
    { id: 'en', catalog: 'locales/../locales/en.json', fallback: [] },
    { id: 'pt', catalog: './locales/pt.json', fallback: ['en'] },
  ])
  const report = await checkProject({ config: site.config })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a root that is itself reached through a symbolic link still works', async (t) => {
  const site = await makeSite(t, INSIDE)
  const linkedRoot = join(site.parent, 'linked-site')
  await symlink(site.site, linkedRoot)

  const report = await checkProject({ config: join(linkedRoot, CONFIG_NAME), root: linkedRoot })
  assert.equal(report.status, 'pass', 'a file genuinely inside the root must not be falsely refused')
  assert.equal(report.summary.audited, 2)
})

test('a catalog reached through a link that stays inside the root is allowed', async (t) => {
  const site = await makeSite(t, [
    { id: 'en', catalog: 'locales/en.json', fallback: [] },
    { id: 'pt', catalog: 'locales/inside-link.json', fallback: ['en'] },
  ])
  await symlink(join(site.site, 'locales', 'pt.json'), join(site.site, 'locales', 'inside-link.json'))
  const report = await checkProject({ config: site.config })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.audited, 2)
})

test('an input root that does not exist is a configuration error', async (t) => {
  const site = await makeSite(t, INSIDE)
  const error = await checkProject({ config: site.config, root: join(site.parent, 'absent') })
    .then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.equal(error.rule, 'input-unresolvable')
})

test('an empty or non-string catalog path is refused before anything is opened', async (t) => {
  const site = await makeSite(t, INSIDE)
  const real = await realpath(site.site)
  for (const candidate of ['   ', '', null, 42]) {
    const error = await resolveWithin(site.site, real, candidate, 'locales[0].catalog')
      .then(() => null, (thrown) => thrown)
    assert.equal(error instanceof ConfigError, true, JSON.stringify(candidate))
    assert.equal(error.rule, 'input-not-relative')
  }
  // The config layer refuses a blank catalog path before resolution is reached.
  const blank = await makeSite(t, [{ id: 'en', catalog: '  ', fallback: [] }])
  await assert.rejects(() => checkProject({ config: blank.config }), /must name the catalog file/u)
})

test('a missing catalog inside the root is a finding, not a refusal', async (t) => {
  const site = await makeSite(t, [
    { id: 'en', catalog: 'locales/en.json', fallback: [] },
    { id: 'pt', catalog: 'locales/never-written.json', fallback: ['en'] },
  ])
  const report = await checkProject({ config: site.config })
  assert.equal(report.findings[0].ruleId, 'catalog-unreadable')
  assert.equal(report.status, 'incomplete')
})
