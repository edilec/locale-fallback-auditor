import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { CONFIG_NAME, BIN, catalogJson, configJson, healthyCatalogs, makeProject, regionalProject, removeProject, runCli } from './helpers.mjs'

const CLEAN = 'examples/clean/locale-fallback.config.json'
const BROKEN = 'examples/broken/locale-fallback.config.json'

async function project(t, files) {
  const root = await makeProject(files)
  t.after(() => removeProject(root))
  return join(root, CONFIG_NAME)
}

test('the executable declares an interpreter and is marked executable', async () => {
  const source = await readFile(BIN, 'utf8')
  assert.equal(source.startsWith('#!/usr/bin/env node\n'), true)
  const { mode } = await (await import('node:fs/promises')).stat(BIN)
  assert.equal((mode & 0o111) !== 0, true, 'bin must be executable')
})

test('--help prints usage on stderr, leaves stdout empty and exits 0', async () => {
  const run = await runCli(['--help'], { timeout: 20000 })
  assert.equal(run.code, 0)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /locale-fallback-auditor/u)
  assert.match(run.stderr, /--require-prefix/u)
  assert.match(run.stderr, /Exit codes:/u)
  assert.equal(run.killed, false)
})

test('a usage error leaves stdout empty and exits 2', async () => {
  for (const args of [[], ['--nope'], ['--config'], ['--config', '--json']]) {
    const run = await runCli(args, { timeout: 20000 })
    assert.equal(run.code, 2, JSON.stringify(args))
    assert.equal(run.stdout, '', 'exit 2 for a configuration error carries no report')
  }
  assert.match((await runCli(['--nope'])).stderr, /Unknown option "--nope"/u)
  assert.match((await runCli([])).stderr, /--config is required/u)
})

test('an unknown option carrying a newline cannot forge a line of output', async () => {
  const run = await runCli(['--bad\nUsage: forged'], { timeout: 20000 })
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.split('\n')[0].includes('forged'), true)
  assert.equal(run.stderr.startsWith('Unknown option "--bad Usage: forged"'), true)
})

test('the clean example passes, and stdout is a report and nothing else', async () => {
  const run = await runCli(['--config', CLEAN], { timeout: 20000 })
  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.tool, 'locale-fallback-auditor')
  assert.equal(report.summary.errors, 0)
  assert.match(run.stderr, /Status pass\./u)
  assert.equal(run.stdout.startsWith('{'), true)
  assert.equal(run.stdout.endsWith('}\n'), true)
})

test('the clean example shows a regional fallback resolving predictably', async () => {
  const report = JSON.parse((await runCli(['--config', CLEAN], { timeout: 20000 })).stdout)
  const fallbacks = report.findings.filter((finding) => finding.ruleId === 'missing-key')
  assert.equal(fallbacks.length, 2)
  const regional = fallbacks.find((finding) => finding.location.file === 'locales/pt-BR.json')
  assert.match(regional.message, /resolves to "en"/u, 'pt-BR reaches en through pt')
})

test('--json suppresses the human summary but not the report', async () => {
  const run = await runCli(['--config', CLEAN, '--json'], { timeout: 20000 })
  assert.equal(run.code, 0)
  assert.equal(run.stderr, '')
  assert.equal(JSON.parse(run.stdout).status, 'pass')
})

test('the broken example exits 2 with a report that says what was not read', async () => {
  const run = await runCli(['--config', BROKEN, '--json'], { timeout: 20000 })
  assert.equal(run.code, 2)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete', 'exit 2 for unreadable evidence still carries a report')
  const ids = new Set(report.findings.map((finding) => finding.ruleId))
  for (const expected of [
    'fallback-cycle',
    'fallback-target-unknown',
    'required-key-satisfied-by-fallback',
    'placeholder-missing',
    'placeholder-unexpected',
    'empty-translation',
    'redundant-fallback-edge',
    'resolution-not-determined',
  ]) {
    assert.equal(ids.has(expected), true, `the broken example should demonstrate ${expected}`)
  }
})

test('a policy failure exits 1 with a report', async (t) => {
  const catalogs = healthyCatalogs()
  delete catalogs['pt-BR'].legal
  const config = await project(t, regionalProject({ catalogs }))
  const run = await runCli(['--config', config, '--json'], { timeout: 20000 })
  assert.equal(run.code, 1)
  assert.equal(JSON.parse(run.stdout).status, 'fail')
})

test('--require-prefix on the command line turns a pass into a failure', async (t) => {
  const catalogs = healthyCatalogs()
  delete catalogs['pt-BR'].checkout
  const config = await project(t, regionalProject({ catalogs }))

  const lenient = await runCli(['--config', config, '--json'], { timeout: 20000 })
  assert.equal(lenient.code, 0)

  const strict = await runCli(['--config', config, '--require-prefix', 'checkout', '--json'], { timeout: 20000 })
  assert.equal(strict.code, 1)
  const ids = JSON.parse(strict.stdout).findings.map((finding) => finding.ruleId)
  assert.equal(ids.includes('required-key-satisfied-by-fallback'), true)
})

test('--root moves the input root the catalogs resolve against', async (t) => {
  const root = await makeProject({
    'project/locale-fallback.config.json': configJson({
      sourceLocale: 'en',
      locales: [{ id: 'en', catalog: 'project/locales/en.json', fallback: [] }],
      requiredKeys: ['legal.terms'],
    }),
    'project/locales/en.json': catalogJson({ legal: { terms: 'Accept.' } }),
  })
  t.after(() => removeProject(root))

  const run = await runCli(['--config', join(root, 'project/locale-fallback.config.json'), '--root', root, '--json'], { timeout: 20000 })
  assert.equal(run.code, 0)
  assert.equal(JSON.parse(run.stdout).summary.audited, 1)

  const unrooted = await runCli(['--config', join(root, 'project/locale-fallback.config.json'), '--json'], { timeout: 20000 })
  assert.equal(unrooted.code, 2, 'without --root the declared path does not exist')
  assert.equal(JSON.parse(unrooted.stdout).findings[0].ruleId, 'catalog-unreadable')
})

test('two runs of the CLI produce byte identical stdout', async () => {
  const first = await runCli(['--config', CLEAN, '--json'], { timeout: 20000 })
  const second = await runCli(['--config', CLEAN, '--json'], { timeout: 20000 })
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
})

test('a translation key holding a newline cannot forge a line in the human summary', async (t) => {
  const catalogs = healthyCatalogs()
  catalogs.pt['forged\nERROR   fake-rule                          locales/pt.json /forged'] = 'x'
  const config = await project(t, regionalProject({ catalogs }))

  const run = await runCli(['--config', config], { timeout: 20000 })
  const report = JSON.parse(run.stdout)
  const lines = run.stderr.split('\n').filter((line) => line !== '')
  // One line per finding, plus the two summary lines. A forged newline would
  // add a line that no finding accounts for.
  assert.equal(lines.length, report.findings.length + 2)
  assert.equal(lines.filter((line) => line.trimStart().startsWith('ERROR')).length, 0)
  assert.equal(report.summary.errors, 0)
})

test('the CLI returns rather than hanging on a large project', async (t) => {
  const catalogs = { en: {}, pt: {}, 'pt-BR': {} }
  for (let index = 0; index < 2000; index += 1) {
    catalogs.en[`k${index}`] = `Value {n} ${index}`
    catalogs.pt[`k${index}`] = `Valor {n} ${index}`
    catalogs['pt-BR'][`k${index}`] = `Valor {n} ${index}`
  }
  const config = await project(t, regionalProject({ catalogs, config: { requiredKeyPrefixes: [] } }))
  const run = await runCli(['--config', config, '--json'], { timeout: 60000 })
  assert.equal(run.killed, false)
  assert.equal(run.code, 0)
  assert.equal(JSON.parse(run.stdout).summary.checked, 6000)
})
