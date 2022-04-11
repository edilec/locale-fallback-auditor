import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  DEFAULT_LIMITS,
  LIMIT_NAMES,
  MAX_CONFIG_BYTES,
  MAX_PATH_LENGTH,
  REPORT_SCHEMA_VERSION,
  TOOL_ID,
  checkProject,
  exitCodeFor,
  renderReport,
  validateConfig,
} from '../src/index.mjs'
import {
  CONFIG_NAME,
  catalogJson,
  configJson,
  findingsFor,
  healthyCatalogs,
  makeProject,
  regionalProject,
  removeProject,
  ruleIdsOf,
} from './helpers.mjs'

async function project(t, files) {
  const root = await makeProject(files)
  t.after(() => removeProject(root))
  return { root, config: join(root, CONFIG_NAME) }
}

async function run(t, files, options = {}) {
  const made = await project(t, files)
  return checkProject({ config: made.config, ...options })
}

async function refuse(t, files, options = {}) {
  const made = await project(t, files)
  const error = await checkProject({ config: made.config, ...options }).then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true, 'expected a ConfigError')
  return error
}

test('a healthy project passes with the documented envelope', async (t) => {
  const report = await run(t, regionalProject({ catalogs: healthyCatalogs() }))
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION)
  assert.equal(report.tool, TOOL_ID)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(exitCodeFor(report), 0)
  assert.equal(report.summary.checked, 6)
  assert.equal(report.summary.locales, 3)
  assert.equal(report.summary.audited, 3)
  assert.equal(report.summary.errors, 0)
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
})

test('the regional chain is what resolves a key the region omits', async (t) => {
  const catalogs = healthyCatalogs()
  delete catalogs['pt-BR'].checkout
  const report = await run(t, regionalProject({ catalogs }))
  const finding = findingsFor(report, 'missing-key')[0]
  assert.equal(findingsFor(report, 'missing-key').length, 1)
  assert.match(finding.message, /"pt-BR"/u)
  assert.match(finding.message, /"pt"/u, 'pt-BR resolves at pt, not at en')
  assert.equal(report.status, 'pass')
})

test('required legal text served from another locale fails the run end to end', async (t) => {
  const catalogs = healthyCatalogs()
  delete catalogs['pt-BR'].legal
  const report = await run(t, regionalProject({ catalogs }))
  const finding = findingsFor(report, 'required-key-satisfied-by-fallback')[0]
  assert.equal(findingsFor(report, 'required-key-satisfied-by-fallback').length, 1)
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.file, 'locales/pt-BR.json')
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('--require-prefix adds a requirement the config forgot', async (t) => {
  const catalogs = healthyCatalogs()
  delete catalogs['pt-BR'].checkout
  const made = await project(t, regionalProject({ catalogs }))

  const lenient = await checkProject({ config: made.config })
  assert.equal(lenient.status, 'pass')

  const strict = await checkProject({ config: made.config, requirePrefixes: ['checkout'] })
  assert.equal(strict.status, 'fail')
  assert.equal(findingsFor(strict, 'required-key-satisfied-by-fallback').length, 1)
})

test('a catalog that could not be read is incomplete, never a pass', async (t) => {
  const files = regionalProject({ catalogs: healthyCatalogs() })
  delete files['locales/pt.json']
  const report = await run(t, files)
  const finding = findingsFor(report, 'catalog-unreadable')[0]
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.file, 'locales/pt.json')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.audited, 2)
})

test('a value the auditor cannot compare is only a warning and still cannot pass', async (t) => {
  const catalogs = healthyCatalogs()
  catalogs['pt-BR'].legal.version = 3
  const report = await run(t, regionalProject({ catalogs }))
  const finding = findingsFor(report, 'catalog-value-not-string')[0]
  assert.equal(finding.severity, 'warning')
  assert.equal(report.summary.errors, 0, 'nothing in this report is an error')
  assert.equal(
    report.status,
    'incomplete',
    'the only thing keeping this off a pass is catalog-value-not-string being evidence-missing',
  )
  assert.equal(exitCodeFor(report), 2)
})

test('a catalog that is not UTF-8 is reported, not decoded lossily', async (t) => {
  const made = await project(t, regionalProject({ catalogs: healthyCatalogs() }))
  await writeFile(join(made.root, 'locales', 'pt.json'), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
  const report = await checkProject({ config: made.config })
  assert.equal(ruleIdsOf(report).includes('catalog-not-utf8'), true)
  assert.equal(report.status, 'incomplete')
})

test('a replacement character in a legitimate UTF-8 catalog is not mistaken for bad bytes', async (t) => {
  const catalogs = healthyCatalogs()
  catalogs.pt.legal.terms = `Aceite os termos ${String.fromCharCode(0xfffd)}`
  const report = await run(t, regionalProject({ catalogs }))
  assert.equal(ruleIdsOf(report).includes('catalog-not-utf8'), false)
  assert.equal(report.status, 'pass')
})

test('the config is decoded as strictly as the catalogs are', async (t) => {
  const made = await project(t, regionalProject({ catalogs: healthyCatalogs() }))
  await writeFile(made.config, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]))
  const error = await checkProject({ config: made.config }).then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.match(error.message, /could not be decoded as UTF-8/u)
})

test('a config larger than the fixed byte bound is refused before it is parsed', async (t) => {
  const files = regionalProject({ catalogs: healthyCatalogs() })
  const report = await run(t, files)
  assert.equal(report.status, 'pass')

  const made = await project(t, files)
  const padding = 'x'.repeat(MAX_CONFIG_BYTES)
  await writeFile(made.config, `${JSON.stringify({ schemaVersion: '1', note: padding })}`)
  const error = await checkProject({ config: made.config }).then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.match(error.message, /over the 1000000 byte limit/u)
})

test('a catalog path longer than the fixed path bound is refused before it is opened', async (t) => {
  const long = `locales/${'a'.repeat(MAX_PATH_LENGTH)}.json`
  const error = await refuse(t, {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [{ id: 'en', catalog: long, fallback: [] }],
    }),
  })
  assert.equal(error.rule, 'input-too-long')
})

test('every documented limit is enforced', async (t) => {
  assert.deepEqual([...LIMIT_NAMES], Object.keys(DEFAULT_LIMITS).sort())

  const big = await run(t, regionalProject({
    catalogs: healthyCatalogs(),
    config: { limits: { maxCatalogBytes: 10 } },
  }))
  assert.equal(ruleIdsOf(big).includes('catalog-too-large'), true)
  assert.equal(big.status, 'incomplete')

  const many = await run(t, regionalProject({
    catalogs: healthyCatalogs(),
    config: { limits: { maxKeysPerCatalog: 1 } },
  }))
  assert.equal(ruleIdsOf(many).includes('catalog-key-limit-exceeded'), true)
  assert.equal(many.status, 'incomplete')

  const deep = await run(t, regionalProject({
    catalogs: healthyCatalogs(),
    config: { limits: { maxCatalogDepth: 1 } },
  }))
  assert.equal(ruleIdsOf(deep).includes('catalog-depth-exceeded'), true)
  assert.equal(deep.status, 'incomplete')

  const shallow = await run(t, regionalProject({
    catalogs: healthyCatalogs(),
    config: { limits: { maxFallbackDepth: 1 } },
  }))
  assert.equal(ruleIdsOf(shallow).includes('fallback-depth-exceeded'), true)
  assert.equal(shallow.status, 'incomplete')

  const crowded = await run(t, regionalProject({
    catalogs: healthyCatalogs(),
    config: { limits: { maxLocales: 2 } },
  }))
  assert.deepEqual(ruleIdsOf(crowded), ['locale-limit-exceeded'])
  assert.equal(crowded.summary.checked, 0, 'nothing is read once the locale limit is passed')
  assert.equal(crowded.status, 'incomplete')
})

test('a one character typo in a limit name is refused, not ignored', async (t) => {
  const error = await refuse(t, regionalProject({
    catalogs: healthyCatalogs(),
    config: { limits: { maxLocale: 2 } },
  }))
  assert.match(error.message, /Unknown limit "maxLocale"/u)
  for (const name of LIMIT_NAMES) {
    assert.throws(() => validateConfig({
      schemaVersion: '1',
      sourceLocale: 'en',
      locales: [{ id: 'en', catalog: 'a.json' }],
      limits: { [name]: 0 },
    }), /must be a positive integer/u, name)
  }
})

test('an unknown config key or locale key is refused', async (t) => {
  assert.match((await refuse(t, {
    [CONFIG_NAME]: `${JSON.stringify({ schemaVersion: '1', sourceLocale: 'en', locales: [], extra: 1 })}\n`,
  })).message, /Unknown config key "extra"/u)

  assert.match((await refuse(t, {
    [CONFIG_NAME]: configJson({ sourceLocale: 'en', locales: [{ id: 'en', catalog: 'a.json', fallbacks: [] }] }),
  })).message, /Unknown key "fallbacks" in locales\[0\]/u)
})

test('the config schema version is checked', async (t) => {
  assert.match((await refuse(t, {
    [CONFIG_NAME]: `${JSON.stringify({ schemaVersion: '2', sourceLocale: 'en', locales: [] })}\n`,
  })).message, /Unsupported config schemaVersion: 2/u)
  assert.equal(CONFIG_SCHEMA_VERSION, '1')
})

test('locale ids are validated at the door', async (t) => {
  const bad = ['pt BR', 'pt\nBR', '-pt', '', 'x'.repeat(36), 'ptçBR']
  for (const id of bad) {
    const error = await refuse(t, {
      [CONFIG_NAME]: configJson({ sourceLocale: 'en', locales: [{ id, catalog: 'a.json' }] }),
    })
    assert.match(error.message, /must be an ASCII locale tag/u, JSON.stringify(id))
    assert.equal(error.message.includes('\n'), false, 'the refusal must not carry the newline it refused')
  }
  assert.doesNotThrow(() => validateConfig({
    schemaVersion: '1',
    sourceLocale: 'pt-BR',
    locales: [{ id: 'pt-BR', catalog: 'a.json' }],
  }))
})

test('two spellings of one locale tag are a configuration error', async (t) => {
  const error = await refuse(t, {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [
        { id: 'en', catalog: 'locales/en.json' },
        { id: 'pt-BR', catalog: 'locales/a.json' },
        { id: 'pt-br', catalog: 'locales/b.json' },
      ],
    }),
  })
  assert.match(error.message, /repeats locales\[1\]\.id/u)
})

test('the source locale must be one of the declared locales', async (t) => {
  const error = await refuse(t, {
    [CONFIG_NAME]: configJson({ sourceLocale: 'sv', locales: [{ id: 'en', catalog: 'a.json' }] }),
  })
  assert.match(error.message, /is not one of the declared locales/u)
})

test('an empty locale list is refused rather than audited vacuously', async (t) => {
  assert.match((await refuse(t, { [CONFIG_NAME]: configJson({ sourceLocale: 'en', locales: [] }) })).message, /non-empty array/u)
})

test('a catalog that is not JSON, or not an object, is reported', async (t) => {
  const files = regionalProject({ catalogs: healthyCatalogs() })
  files['locales/pt.json'] = '{ not json\n'
  const broken = await run(t, files)
  assert.equal(findingsFor(broken, 'catalog-unparsable').length, 1)
  assert.equal(broken.status, 'incomplete')

  const listed = regionalProject({ catalogs: healthyCatalogs() })
  listed['locales/pt.json'] = '["a"]\n'
  const report = await run(t, listed)
  assert.match(findingsFor(report, 'catalog-unparsable')[0].message, /not a JSON object at the top level/u)
})

test('a run that resolved nothing is incomplete, never a pass with checked 0', async (t) => {
  const report = await run(t, {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [{ id: 'en', catalog: 'locales/en.json', fallback: [] }],
      requiredKeyPrefixes: ['legal'],
    }),
    'locales/en.json': catalogJson({}),
  })
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(ruleIdsOf(report), ['no-keys-checked', 'required-key-unknown'])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('no-keys-checked is not emitted on top of an explanation already given', async (t) => {
  const report = await run(t, {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [{ id: 'en', catalog: 'locales/en.json', fallback: [] }],
      requiredKeys: ['legal.terms'],
    }),
  })
  assert.deepEqual(ruleIdsOf(report), ['catalog-unreadable'])
  assert.equal(report.status, 'incomplete')
})

test('a two path key is reported and the report says which value was kept', async (t) => {
  const files = regionalProject({ catalogs: healthyCatalogs() })
  files['locales/pt.json'] = '{"legal.terms": "dotted", "legal": {"terms": "nested"}, "checkout": {"total": "Total {amount}"}}\n'
  const report = await run(t, files)
  assert.equal(findingsFor(report, 'duplicate-flattened-key').length, 1)
  assert.match(findingsFor(report, 'duplicate-flattened-key')[0].message, /The first was kept/u)
  assert.equal(report.status, 'incomplete')
})

test('untrusted keys are sanitised and escaped everywhere they reach the report', async (t) => {
  const catalogs = healthyCatalogs()
  catalogs.pt['forged\nERROR fake-rule'] = 'value'
  catalogs.pt['a/b~c'] = 'value'
  const report = await run(t, regionalProject({ catalogs }))
  const extras = findingsFor(report, 'extra-key')
  assert.equal(extras.length, 2)
  for (const finding of extras) {
    assert.equal(finding.message.includes('\n'), false)
    assert.equal(finding.location.pointer.includes('\n'), false)
  }
  const escaped = extras.find((finding) => finding.location.pointer.includes('~1'))
  assert.equal(escaped.location.pointer, '/locales/1/keys/a~1b~0c')
})

test('a separator in a catalog key never reaches stdout raw', async (t) => {
  const catalogs = healthyCatalogs()
  catalogs.pt[`sep${String.fromCharCode(0x2028)}key`] = 'value'
  const report = await run(t, regionalProject({ catalogs }))
  const rendered = renderReport(report)
  assert.equal(rendered.includes(String.fromCharCode(0x2028)), false)
  assert.equal(rendered.includes(String.fromCharCode(0x2029)), false)
  assert.deepEqual(JSON.parse(rendered).summary, report.summary)
})

test('renderReport escapes the two separators for any report handed to it', () => {
  // renderReport is exported, so it must hold on its own rather than relying on
  // the finding builder having already stripped the character. Both separators
  // are legal raw in JSON and are line terminators in a JavaScript string, so a
  // payload carrying one parses as JSON and breaks a consumer that evaluates it.
  const line = String.fromCharCode(0x2028)
  const paragraph = String.fromCharCode(0x2029)
  const report = {
    schemaVersion: '1',
    tool: 'locale-fallback-auditor',
    status: 'fail',
    summary: { checked: 1 },
    findings: [{
      ruleId: 'extra-key',
      severity: 'warning',
      message: `before${line}after`,
      location: { file: `a${paragraph}.json` },
      evidence: `v${line}${paragraph}w`,
    }],
  }
  const rendered = renderReport(report)
  assert.equal(rendered.includes(line), false)
  assert.equal(rendered.includes(paragraph), false)
  assert.equal(rendered.includes(String.raw`\u2028`), true)
  assert.equal(rendered.includes(String.raw`\u2029`), true)
  assert.deepEqual(JSON.parse(rendered), report, 'the escaped payload still parses back to the same report')
})

test('accented translations survive the round trip unchanged', async (t) => {
  const catalogs = healthyCatalogs()
  catalogs.pt.legal.terms = 'Ao continuar, você aceita os Termos de Serviço.'
  catalogs.pt.extra = 'Registos são mantidos'
  const report = await run(t, regionalProject({ catalogs }))
  assert.equal(findingsFor(report, 'extra-key')[0].evidence, 'Registos são mantidos')
})

test('two runs over the same inputs produce byte identical stdout', async (t) => {
  const made = await project(t, regionalProject({ catalogs: healthyCatalogs(), config: { requiredKeyPrefixes: [] } }))
  const first = renderReport(await checkProject({ config: made.config }))
  const second = renderReport(await checkProject({ config: made.config }))
  assert.equal(first, second)
  assert.equal(first.endsWith('\n'), true)
})

test('a missing config file is a configuration error, not an empty report', async () => {
  const error = await checkProject({ config: '/nonexistent/locale-fallback.config.json' })
    .then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.match(error.message, /Could not load the config/u)
})
