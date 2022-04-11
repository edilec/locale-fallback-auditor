import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analyzeGraph,
  auditCatalogs,
  auditGraph,
  buildGraph,
  exitCodeFor,
  requiredMatcher,
  resolveKey,
  sortFindings,
  statusFor,
} from '../src/index.mjs'
import { localeRecords } from './helpers.mjs'

/**
 * Run the audit over literal catalogs. `locales` is a list of `[id, fallback]`
 * pairs; `catalogs` maps a locale id to its flattened key/value pairs. A locale
 * with no entry in `catalogs` stands for one whose file could not be read.
 */
function audit({ locales, catalogs, required = { keys: [], prefixes: [] }, source = 'en', maxDepth = 16 }) {
  const records = localeRecords(locales)
  const graph = buildGraph(records)
  const analysis = analyzeGraph(graph, { maxDepth })
  const loaded = new Map(
    Object.entries(catalogs).map(([id, values]) => [
      id.toLowerCase(),
      { file: `locales/${id}.json`, values: new Map(Object.entries(values)) },
    ]),
  )
  const result = auditCatalogs({
    locales: records,
    catalogs: loaded,
    sourceKey: source.toLowerCase(),
    orders: analysis.orders,
    truncatedChains: analysis.truncated,
    required,
  })
  const findings = sortFindings([...auditGraph(graph, analysis), ...result.findings])
  return { ...result, findings, status: statusFor(findings) }
}

const CHAIN = [['en', []], ['pt', ['en']], ['pt-BR', ['pt']]]
const LEGAL = { keys: [], prefixes: ['legal'] }

function ids(report) {
  return report.findings.map((finding) => finding.ruleId)
}

function only(report, ruleId) {
  const matches = report.findings.filter((finding) => finding.ruleId === ruleId)
  assert.equal(matches.length, 1, `expected exactly one ${ruleId}, got ${ids(report).join(', ')}`)
  return matches[0]
}

test('a fully translated chain reports nothing and passes', () => {
  const report = audit({
    locales: CHAIN,
    catalogs: {
      en: { 'legal.terms': 'Accept the terms.', 'checkout.total': 'Total {amount}' },
      pt: { 'legal.terms': 'Aceite os termos.', 'checkout.total': 'Total {amount}' },
      'pt-BR': { 'legal.terms': 'Aceite os termos.', 'checkout.total': 'Total {amount}' },
    },
    required: LEGAL,
  })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.equal(report.checked, 6)
  assert.equal(report.keys, 2)
  assert.equal(report.requiredKeys, 1)
})

test('a required key served from a fallback is an error naming the key and the locale', () => {
  const report = audit({
    locales: CHAIN,
    catalogs: {
      en: { 'legal.terms': 'Accept the terms.' },
      pt: { 'legal.terms': 'Aceite os termos.' },
      'pt-BR': {},
    },
    required: LEGAL,
  })
  const finding = only(report, 'required-key-satisfied-by-fallback')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /legal\.terms/u)
  assert.match(finding.message, /"pt-BR"/u)
  assert.match(finding.message, /"pt"/u, 'the locale the text would come from must be named')
  assert.equal(finding.location.file, 'locales/pt-BR.json')
  assert.equal(finding.location.pointer, '/locales/2/keys/legal.terms')
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.equal(ids(report).includes('missing-key'), false, 'a required key is never downgraded to missing-key')
})

test('the same key without the required mark is only a warning, and the run passes', () => {
  const report = audit({
    locales: CHAIN,
    catalogs: {
      en: { 'legal.terms': 'Accept the terms.' },
      pt: { 'legal.terms': 'Aceite os termos.' },
      'pt-BR': {},
    },
    required: { keys: ['nothing.here'], prefixes: [] },
  })
  assert.equal(only(report, 'missing-key').message.includes('"pt"'), true)
  assert.equal(ids(report).includes('required-key-satisfied-by-fallback'), false)
  assert.equal(report.status, 'fail', 'requiredKeys still names a key the source does not define')
  assert.deepEqual(ids(report).filter((id) => id !== 'required-key-unknown'), ['missing-key'])
})

test('a prefix covers its subtree and stops at the dot', () => {
  const isRequired = requiredMatcher({ keys: ['product.name'], prefixes: ['legal'] })
  assert.equal(isRequired('legal'), true)
  assert.equal(isRequired('legal.terms'), true)
  assert.equal(isRequired('legal.gdpr.notice'), true)
  assert.equal(isRequired('legalese'), false)
  assert.equal(isRequired('legalese.terms'), false)
  assert.equal(isRequired('product.name'), true)
  assert.equal(isRequired('product.names'), false)
  assert.equal(requiredMatcher()('anything'), false)
})

test('a required key that resolves nowhere is reported as missing, not as a fallback', () => {
  const report = audit({
    locales: [['en', []], ['ja', []]],
    catalogs: { en: { 'legal.terms': 'Accept.' }, ja: {} },
    required: LEGAL,
  })
  const finding = only(report, 'required-key-missing')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.file, 'locales/ja.json')
  assert.equal(report.status, 'fail')
})

test('an unrequired key that resolves nowhere is unresolved-key', () => {
  const report = audit({
    locales: [['en', []], ['ja', []]],
    catalogs: { en: { 'checkout.total': 'Total' }, ja: {} },
    required: LEGAL,
  })
  assert.deepEqual(ids(report), ['required-key-unknown', 'unresolved-key'])
  assert.equal(only(report, 'unresolved-key').severity, 'error')
})

test('a blank value is reported and does not satisfy a required key', () => {
  const report = audit({
    locales: CHAIN,
    catalogs: {
      en: { 'legal.terms': 'Accept the terms.' },
      pt: { 'legal.terms': 'Aceite os termos.' },
      'pt-BR': { 'legal.terms': '   ' },
    },
    required: LEGAL,
  })
  assert.deepEqual(ids(report).sort(), ['empty-translation', 'required-key-satisfied-by-fallback'])
  assert.equal(only(report, 'empty-translation').location.file, 'locales/pt-BR.json')
})

test('a key the source does not define is reported against the locale that has it', () => {
  const report = audit({
    locales: CHAIN,
    catalogs: {
      en: { 'legal.terms': 'Accept.' },
      pt: { 'legal.terms': 'Aceite.', 'checkout.legacy': 'Antigo' },
      'pt-BR': { 'legal.terms': 'Aceite.' },
    },
    required: LEGAL,
  })
  const finding = only(report, 'extra-key')
  assert.equal(finding.severity, 'warning')
  assert.equal(finding.location.file, 'locales/pt.json')
  assert.equal(finding.evidence, 'Antigo')
  assert.equal(report.status, 'pass', 'an extra key alone does not fail the run')
})

test('a dropped placeholder and an invented one are both errors', () => {
  const report = audit({
    locales: [['en', []], ['de', ['en']]],
    catalogs: {
      en: { 'checkout.total': 'Total {amount}', 'legal.retention': 'Kept {years} years' },
      de: { 'checkout.total': 'Summe {amount} ({currency})', 'legal.retention': 'Aufbewahrt' },
    },
    required: LEGAL,
  })
  const missing = only(report, 'placeholder-missing')
  assert.match(missing.message, /\{years\}/u)
  assert.equal(missing.location.file, 'locales/de.json')
  const unexpected = only(report, 'placeholder-unexpected')
  assert.match(unexpected.message, /\{currency\}/u)
  assert.equal(report.status, 'fail')
})

test('placeholder repetition is not compared, which the docs call a non-goal', () => {
  const report = audit({
    locales: [['en', []], ['de', ['en']]],
    catalogs: {
      en: { greeting: 'Hi {name}' },
      de: { greeting: 'Hallo {name}, wirklich {name}' },
    },
  })
  assert.equal(ids(report).includes('placeholder-missing'), false)
  assert.equal(ids(report).includes('placeholder-unexpected'), false)
})

test('a required value identical to the source is a warning, not a failure', () => {
  const report = audit({
    locales: [['en', []], ['pt', ['en']]],
    catalogs: {
      en: { 'product.name': 'Edilec Ledger', 'checkout.ok': 'OK' },
      pt: { 'product.name': 'Edilec Ledger', 'checkout.ok': 'OK' },
    },
    required: { keys: ['product.name'], prefixes: [] },
  })
  const finding = only(report, 'untranslated-copy')
  assert.equal(finding.severity, 'warning')
  assert.equal(finding.location.file, 'locales/pt.json')
  assert.equal(report.status, 'pass')
  assert.equal(ids(report).length, 1, 'an identical unrequired value is not reported')
})

test('a required key or prefix the source does not define is reported, not silently ignored', () => {
  const report = audit({
    locales: [['en', []]],
    catalogs: { en: { 'legal.terms': 'Accept.' } },
    required: { keys: ['legal.typo'], prefixes: ['regulated'] },
  })
  assert.deepEqual(ids(report), ['required-key-unknown', 'required-key-unknown'])
  assert.equal(report.findings[0].location.file, 'locales/en.json')
  assert.equal(report.status, 'fail')
})

test('declaring no required content at all is reported, because the central check had no subject', () => {
  const report = audit({
    locales: [['en', []], ['pt', ['en']]],
    catalogs: { en: { a: 'A' }, pt: { a: 'B' } },
    required: { keys: [], prefixes: [] },
  })
  assert.deepEqual(ids(report), ['no-required-keys-declared'])
  assert.equal(report.status, 'pass')
})

test('a locale whose catalog was never loaded is not given a verdict', () => {
  const report = audit({
    locales: CHAIN,
    catalogs: {
      en: { 'legal.terms': 'Accept.', 'checkout.total': 'Total' },
      'pt-BR': { 'legal.terms': 'Aceite.' },
    },
    required: LEGAL,
  })
  assert.equal(report.audited, 2, 'pt was not read, so it was not audited')
  assert.equal(ids(report).some((id) => id.startsWith('required-key')), false)
  // pt-BR falls back through pt, which was not read, so its answer is unknown.
  const undetermined = only(report, 'resolution-not-determined')
  assert.equal(undetermined.severity, 'warning')
  assert.equal(report.undetermined, 1)
  assert.equal(report.status, 'incomplete', 'unread evidence is never a pass')
  assert.equal(exitCodeFor(report), 2)
})

test('a truncated chain makes the keys past the break undetermined, not missing', () => {
  const report = audit({
    locales: [['en', []], ['fr', ['xx']]],
    catalogs: { en: { 'legal.terms': 'Accept.', 'checkout.total': 'Total' }, fr: { 'legal.terms': 'Acceptez.' } },
    required: LEGAL,
  })
  assert.equal(ids(report).includes('unresolved-key'), false, 'the tool does not claim a key is absent when it never looked')
  assert.equal(ids(report).includes('required-key-missing'), false)
  assert.equal(only(report, 'fallback-target-unknown').severity, 'error')
  assert.equal(only(report, 'resolution-not-determined').message.includes('1 key(s)'), true)
  assert.equal(report.undetermined, 1)
  assert.equal(report.status, 'incomplete')
})

test('keys that resolve before the break still get a verdict', () => {
  const report = audit({
    locales: [['en', []], ['de', ['en', 'xx']]],
    catalogs: { en: { 'legal.terms': 'Accept.' }, de: {} },
    required: LEGAL,
  })
  assert.equal(only(report, 'required-key-satisfied-by-fallback').location.file, 'locales/de.json')
  assert.equal(report.undetermined, 0)
})

test('a cycle is reported once, terminates, and fails the run', () => {
  const report = audit({
    locales: [['en', []], ['pt', ['pt-BR']], ['pt-BR', ['pt']]],
    catalogs: { en: { 'legal.terms': 'Accept.' }, pt: { 'legal.terms': 'Aceite.' }, 'pt-BR': { 'legal.terms': 'Aceite.' } },
    required: LEGAL,
  })
  const finding = only(report, 'fallback-cycle')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /pt -> pt-BR -> pt/u)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('the graph findings carry the declared locale index in their pointer', () => {
  const report = audit({
    locales: [['en', []], ['de', ['en']], ['de-AT', ['de', 'en']], ['fr', ['xx']]],
    catalogs: { en: { a: 'A' }, de: { a: 'B' }, 'de-AT': { a: 'C' }, fr: { a: 'D' } },
    required: { keys: ['a'], prefixes: [] },
  })
  assert.equal(only(report, 'redundant-fallback-edge').location.pointer, '/locales/2/fallback/1')
  assert.equal(only(report, 'redundant-fallback-edge').severity, 'info')
  assert.equal(only(report, 'fallback-target-unknown').location.pointer, '/locales/3/fallback/0')
})

test('the fallback depth limit reports what was not followed', () => {
  const report = audit({
    locales: [['a', ['b']], ['b', ['c']], ['c', []]],
    catalogs: { a: { k: 'A' }, b: { k: 'B' }, c: { k: 'C' } },
    source: 'a',
    required: { keys: ['k'], prefixes: [] },
    maxDepth: 2,
  })
  const finding = only(report, 'fallback-depth-exceeded')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /depth 3/u)
  assert.equal(report.status, 'incomplete')
})

test('resolveKey reports the state, never a guess', () => {
  const catalogs = new Map([
    ['pt-br', { file: 'a', values: new Map([['own', 'v']]) }],
    ['en', { file: 'b', values: new Map([['shared', 'v'], ['blank', '  ']]) }],
  ])
  assert.deepEqual(resolveKey('own', ['pt-br', 'en'], catalogs, false), { state: 'self', at: 'pt-br' })
  assert.deepEqual(resolveKey('shared', ['pt-br', 'en'], catalogs, false), { state: 'fallback', at: 'en' })
  assert.deepEqual(resolveKey('blank', ['pt-br', 'en'], catalogs, false), { state: 'absent', at: null })
  assert.deepEqual(resolveKey('gone', ['pt-br', 'en'], catalogs, true), { state: 'undetermined', at: null })
  assert.deepEqual(resolveKey('shared', ['pt-br', 'pt', 'en'], catalogs, false), { state: 'undetermined', at: 'pt' })
})

test('the audit reports nothing at all when the source catalog was not read', () => {
  const report = audit({
    locales: CHAIN,
    catalogs: { pt: { 'legal.terms': 'Aceite.' } },
    required: LEGAL,
  })
  assert.deepEqual(report.findings, [])
  assert.equal(report.checked, 0)
  assert.equal(report.keys, 0)
  assert.equal(report.audited, 0)
})
