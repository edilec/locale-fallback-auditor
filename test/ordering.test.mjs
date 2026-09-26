import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  EVIDENCE_MISSING_RULES,
  LIMIT_NAMES,
  DEFAULT_LIMITS,
  RULE_IDS,
  RULE_SEVERITY,
  analyzeGraph,
  at,
  auditCatalogs,
  buildGraph,
  checkProject,
  cycleKey,
  flattenCatalog,
  makeFinding,
  renderReport,
  sortFindings,
  usableKeys,
} from '../src/index.mjs'
import { CONFIG_NAME, catalogJson, configJson, localeRecords, makeProject, removeProject } from './helpers.mjs'

/**
 * Ordering is a documented guarantee: findings sort by
 * `(file, pointer, ruleId, message)`, each compared by UTF-16 code unit rather
 * than by collation, so the report does not change with the ICU data a Node
 * build happens to carry.
 *
 * Grepping the source for `.localeCompare(` does not defend that. Substituting
 * an `Intl.Collator` gives the same machine-dependent order and different
 * source text, so the grep passes and the report quietly starts depending on
 * the host.
 *
 * Every fixture below therefore uses inputs whose order genuinely differs
 * between the two: `Z` before `a`, `a-b` before `a_b`, `README` before
 * `assets`. Collation treats an underscore and a hyphen as ignorable
 * punctuation and sorts lowercase before uppercase; code units do neither. Each
 * assertion is the exact emitted order, so swapping any comparator for a
 * collator moves it.
 */
const DIVERGING = ['Zed', 'a-b', 'aSb', 'a_b', 'ab']
// Code unit: 'Z' is 0x5A, 'S' is 0x53, '-' is 0x2D, '_' is 0x5F, 'b' is 0x62.
const BY_CODE_UNIT = ['Zed', 'a-b', 'aSb', 'a_b', 'ab']

async function reportFor(t, files) {
  const root = await makeProject(files)
  t.after(() => removeProject(root))
  return checkProject({ config: join(root, CONFIG_NAME) })
}

test('the fixtures really do tell code unit order and collation apart', () => {
  // Sanity, without asking what any collator on this machine thinks: the
  // strings below are in code unit order, and the two properties that collation
  // is known to reverse -- case and ignorable punctuation -- are both present.
  assert.deepEqual([...DIVERGING].sort(), BY_CODE_UNIT)
  assert.ok('Z' < 'a', 'uppercase sorts first by code unit and last by collation')
  assert.ok('a-b' < 'a_b', 'the hyphen sorts first by code unit; collation ignores both')
  assert.ok('README' < 'assets')
})

test('findings sort by file in code unit order, not collation order', async (t) => {
  const report = await reportFor(t, {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [
        { id: 'en', catalog: 'locales/en.json', fallback: [] },
        { id: 'zu', catalog: 'locales/Zulu.json', fallback: ['en'] },
        { id: 'al', catalog: 'locales/assets.json', fallback: ['en'] },
      ],
      requiredKeyPrefixes: ['legal'],
    }),
    'locales/en.json': catalogJson({ legal: { terms: 'Accept.' } }),
    'locales/Zulu.json': catalogJson({ legal: { terms: 'Amukela.' }, stray: 'x' }),
    'locales/assets.json': catalogJson({ legal: { terms: 'Accepteer.' }, stray: 'x' }),
  })
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ['locales/Zulu.json', 'locales/assets.json'],
    'collation would put assets.json first',
  )
})

test('findings sort by pointer in code unit order, not collation order', async (t) => {
  const report = await reportFor(t, {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [
        { id: 'en', catalog: 'locales/en.json', fallback: [] },
        { id: 'pt', catalog: 'locales/pt.json', fallback: ['en'] },
      ],
      requiredKeyPrefixes: ['legal'],
    }),
    'locales/en.json': catalogJson({ legal: { terms: 'Accept.' } }),
    'locales/pt.json': catalogJson({
      legal: { terms: 'Aceite.' },
      ab: 'x',
      a_b: 'x',
      'a-b': 'x',
      aSb: 'x',
      Zed: 'x',
    }),
  })
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    BY_CODE_UNIT.map((key) => `/locales/1/keys/${key}`),
    'collation would put a_b first and Zed last',
  )
  // The same order survives serialisation, which is what a consumer diffs.
  const rendered = renderReport(report)
  assert.ok(rendered.indexOf('keys/Zed') < rendered.indexOf('keys/a-b'))
  assert.ok(rendered.indexOf('keys/a-b') < rendered.indexOf('keys/a_b'))
})

test('findings sort by message in code unit order once file and pointer tie', () => {
  const location = at('locales/pt.json', '/locales/1/keys/legal.terms')
  const findings = [
    makeFinding('missing-key', 'assets are missing', location),
    makeFinding('missing-key', 'README is missing', location),
    makeFinding('missing-key', 'Zed is missing', location),
    makeFinding('missing-key', 'a-b is missing', location),
    makeFinding('missing-key', 'a_b is missing', location),
  ]
  assert.deepEqual(
    sortFindings(findings).map((finding) => finding.message),
    ['README is missing', 'Zed is missing', 'a-b is missing', 'a_b is missing', 'assets are missing'],
    'collation would open with a-b and close with README',
  )
})

test('the placeholder names in a message are in code unit order', async (t) => {
  const report = await reportFor(t, {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [
        { id: 'en', catalog: 'locales/en.json', fallback: [] },
        { id: 'pt', catalog: 'locales/pt.json', fallback: ['en'] },
      ],
      requiredKeys: ['checkout.total'],
    }),
    'locales/en.json': catalogJson({ checkout: { total: 'Total {ab} {a_b} {aSb} {a-b} {Zed}' } }),
    'locales/pt.json': catalogJson({ checkout: { total: 'Total a pagar' } }),
  })
  assert.equal(report.findings.length, 1)
  assert.equal(
    report.findings[0].message.includes('{Zed}, {a-b}, {aSb}, {a_b}, {ab}'),
    true,
    `collation would reorder the list: ${report.findings[0].message}`,
  )
})

test('the cycle a report names is the one the code unit smallest locale reaches', async (t) => {
  // analyzeGraph walks the locales in code unit order, and the first walk to
  // find the loop is the one whose path the finding quotes. Under collation
  // "a_b" is visited first and the same loop is reported the other way round.
  const report = await reportFor(t, {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [
        { id: 'en', catalog: 'locales/en.json', fallback: [] },
        { id: 'a-b', catalog: 'locales/a-b.json', fallback: ['a_b'] },
        { id: 'a_b', catalog: 'locales/a_b.json', fallback: ['a-b'] },
      ],
      requiredKeyPrefixes: ['legal'],
    }),
    'locales/en.json': catalogJson({ legal: { terms: 'Accept.' } }),
    'locales/a-b.json': catalogJson({ legal: { terms: 'Hyphen.' } }),
    'locales/a_b.json': catalogJson({ legal: { terms: 'Underscore.' } }),
  })
  const cycles = report.findings.filter((finding) => finding.ruleId === 'fallback-cycle')
  assert.equal(cycles.length, 1)
  assert.match(cycles[0].message, /a-b -> a_b -> a-b/u)
  assert.equal(cycles[0].message.includes('a_b -> a-b -> a_b'), false)
})

test('cycleKey pivots on the code unit smallest member', () => {
  assert.equal(cycleKey(['a-b', 'a_b', 'a-b']), 'a-b -> a_b')
  assert.equal(cycleKey(['a_b', 'a-b', 'a_b']), 'a-b -> a_b', 'one loop has one key whichever way it is entered')
  assert.equal(cycleKey(['Zed', 'ab', 'Zed']), 'Zed -> ab')
  assert.equal(cycleKey(['ab', 'Zed', 'ab']), 'Zed -> ab')
})

test('the graph analysis lists defects in code unit order', () => {
  const graph = buildGraph(localeRecords([
    ['ab', ['xx']],
    ['a_b', ['xx']],
    ['a-b', ['xx']],
    ['aSb', ['xx']],
    ['Zed', ['xx']],
  ]))
  const analysis = analyzeGraph(graph, { maxDepth: 16 })
  // Graph keys are the ASCII lowercased locale ids, so the divergence that
  // survives lowercasing is the punctuation: collation would open with a_b.
  assert.deepEqual(analysis.unknown.map((entry) => entry.fromKey), ['a-b', 'a_b', 'ab', 'asb', 'zed'])
})

test('the flattener returns every list in code unit order', () => {
  const nonStrings = flattenCatalog(
    { ab: 1, a_b: 2, aSb: 3, 'a-b': 4, Zed: 5 },
    { maxDepth: 12, maxKeys: 20 },
  )
  assert.deepEqual(nonStrings.nonStrings.map((entry) => entry.key), BY_CODE_UNIT)

  const tooDeep = flattenCatalog(
    {
      ab: { under: 'x' },
      a_b: { under: 'x' },
      aSb: { under: 'x' },
      'a-b': { under: 'x' },
      Zed: { under: 'x' },
    },
    { maxDepth: 1, maxKeys: 20 },
  )
  assert.deepEqual(tooDeep.tooDeep, BY_CODE_UNIT)

  const duplicates = flattenCatalog(
    JSON.parse('{"Zed.k": "1", "Zed": {"k": "2"}, "a-b.k": "1", "a-b": {"k": "2"}}'),
    { maxDepth: 12, maxKeys: 20 },
  )
  assert.deepEqual(duplicates.duplicates, ['Zed.k', 'a-b.k'])

  assert.deepEqual(usableKeys(new Map(DIVERGING.map((key) => [key, 'value']))), BY_CODE_UNIT)
})

test('the audit walks a catalog key by key in code unit order', () => {
  const records = localeRecords([['en', []], ['pt', ['en']]])
  const catalogs = new Map([
    ['en', { file: 'locales/en.json', values: new Map([['legal.terms', 'Accept.']]) }],
    ['pt', {
      file: 'locales/pt.json',
      values: new Map([...DIVERGING.map((key) => [key, 'x']), ['legal.terms', 'Aceite.']]),
    }],
  ])
  const analysis = analyzeGraph(buildGraph(records), { maxDepth: 16 })
  const result = auditCatalogs({
    locales: records,
    catalogs,
    sourceKey: 'en',
    orders: analysis.orders,
    truncatedChains: analysis.truncated,
    required: { keys: ['legal.terms'], prefixes: [] },
  })
  // Unsorted, as the audit produced them: the walk itself is ordered, so a
  // report is the same whatever order a Map happens to iterate in.
  assert.deepEqual(
    result.findings.map((finding) => finding.location.pointer),
    BY_CODE_UNIT.map((key) => `/locales/1/keys/${key}`),
  )
})

test('the rule id tiebreak orders every pair of rule ids by code unit', () => {
  // No two rule ids in the catalog order differently under code units and
  // under collation -- they are lowercase ASCII words joined by single hyphens
  // -- so no fixture can make a collator visible at this one comparator. What
  // this does instead is compare the emitted order against the default
  // `Array.prototype.sort`, which compares UTF-16 code units by definition and
  // needs no ICU data of its own. It passes today whichever comparator the
  // source uses, and starts failing the moment a rule id is added that the two
  // disagree about, which is exactly when the difference becomes reportable.
  const location = at('locales/pt.json', '/locales/1/keys/legal.terms')
  for (const first of RULE_IDS) {
    for (const second of RULE_IDS) {
      if (first === second) continue
      const sorted = sortFindings([
        makeFinding(first, 'same message', location),
        makeFinding(second, 'same message', location),
      ])
      assert.deepEqual(sorted.map((finding) => finding.ruleId), [first, second].sort(), `${first} vs ${second}`)
    }
  }
})

test('the exported catalogs are in code unit order', () => {
  assert.deepEqual([...RULE_IDS], Object.keys(RULE_SEVERITY).sort())
  assert.deepEqual([...EVIDENCE_MISSING_RULES], [...EVIDENCE_MISSING_RULES].sort())
  assert.deepEqual([...LIMIT_NAMES], Object.keys(DEFAULT_LIMITS).sort())
})
