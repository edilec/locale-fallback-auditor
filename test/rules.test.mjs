import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EVIDENCE_LIMIT,
  EVIDENCE_MISSING_RULES,
  IDENTIFIER_LIMIT,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  at,
  byCodeUnit,
  compareFindings,
  excerpt,
  exitCodeFor,
  makeFinding,
  marksEvidenceMissing,
  pointerSegment,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
  stripControls,
} from '../src/index.mjs'

const DOCS = fileURLToPath(new URL('../docs/locale-fallback-rules.md', import.meta.url))

/**
 * A third, hand-written copy of the catalog.
 *
 * The code/doc cross-check below passes if both are edited together, so this
 * copy exists to make a quiet severity change cost a third edit in a file whose
 * only purpose is to disagree.
 */
const EXPECTED = {
  'catalog-depth-exceeded': ['error', true],
  'catalog-key-limit-exceeded': ['error', true],
  'catalog-not-utf8': ['error', true],
  'catalog-too-large': ['error', true],
  'catalog-unparsable': ['error', true],
  'catalog-unreadable': ['error', true],
  'catalog-value-not-string': ['warning', true],
  'duplicate-flattened-key': ['error', true],
  'empty-translation': ['error', false],
  'extra-key': ['warning', false],
  'fallback-cycle': ['error', false],
  'fallback-depth-exceeded': ['error', true],
  'fallback-target-unknown': ['error', true],
  'locale-limit-exceeded': ['error', true],
  'missing-key': ['warning', false],
  'no-keys-checked': ['error', true],
  'no-required-keys-declared': ['warning', false],
  'placeholder-missing': ['error', false],
  'placeholder-unexpected': ['error', false],
  'redundant-fallback-edge': ['info', false],
  'required-key-missing': ['error', false],
  'required-key-satisfied-by-fallback': ['error', false],
  'required-key-unknown': ['error', false],
  'resolution-not-determined': ['warning', true],
  'unresolved-key': ['error', false],
  'untranslated-copy': ['warning', false],
}

function documentedRules(markdown) {
  const rules = new Map()
  for (const line of markdown.split('\n')) {
    const match = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \|/u.exec(line)
    if (match !== null) rules.set(match[1], [match[2], match[3] === 'yes'])
  }
  return rules
}

test('the hand-written catalog and the code agree exactly', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(byCodeUnit), [...RULE_IDS])
  for (const [ruleId, [severity, evidenceMissing]] of Object.entries(EXPECTED)) {
    assert.equal(severityFor(ruleId), severity, `severity of ${ruleId}`)
    assert.equal(marksEvidenceMissing(ruleId), evidenceMissing, `evidence flag of ${ruleId}`)
  }
})

test('the documented catalog and the code agree in both directions', async () => {
  const documented = documentedRules(await readFile(DOCS, 'utf8'))

  for (const ruleId of RULE_IDS) {
    assert.ok(documented.has(ruleId), `${ruleId} is not documented`)
    const [severity, evidenceMissing] = documented.get(ruleId)
    assert.equal(severity, RULE_SEVERITY[ruleId], `documented severity of ${ruleId}`)
    assert.equal(evidenceMissing, marksEvidenceMissing(ruleId), `documented evidence flag of ${ruleId}`)
  }
  for (const ruleId of documented.keys()) {
    assert.ok(RULE_IDS.includes(ruleId), `${ruleId} is documented but not implemented`)
  }
  assert.equal(documented.size, RULE_IDS.length)
})

test('every severity is one of the three the contract allows', () => {
  for (const ruleId of RULE_IDS) assert.ok(SEVERITIES.includes(severityFor(ruleId)), ruleId)
  assert.deepEqual([...SEVERITIES], ['error', 'warning', 'info'])
})

test('the catalog is frozen and an unknown rule id throws rather than defaulting', () => {
  assert.throws(() => severityFor('not-a-rule'), /Unknown ruleId/u)
  assert.throws(() => marksEvidenceMissing('not-a-rule'), /Unknown ruleId/u)
  assert.throws(() => makeFinding('not-a-rule', 'x', at('a.json', '/x')), /Unknown ruleId/u)
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.throws(() => {
    'use strict'
    RULE_SEVERITY['fallback-cycle'] = 'info'
  }, TypeError)
  assert.equal(RULE_SEVERITY['fallback-cycle'], 'error')
})

test('each rule on its own produces the status and exit code the catalog implies', () => {
  for (const [ruleId, [severity, evidenceMissing]] of Object.entries(EXPECTED)) {
    const report = { findings: [makeFinding(ruleId, 'observed', at('a.json', '/a'))] }
    const status = statusFor(report.findings)
    const expected = evidenceMissing ? 'incomplete' : severity === 'error' ? 'fail' : 'pass'
    assert.equal(status, expected, `status for ${ruleId}`)
    const exit = exitCodeFor({ status })
    assert.equal(exit, expected === 'pass' ? 0 : expected === 'fail' ? 1 : 2, `exit for ${ruleId}`)
  }
})

test('a warning that marks missing evidence cannot pass, and one that does not can', () => {
  const softEvidenceMissing = EVIDENCE_MISSING_RULES.filter((ruleId) => severityFor(ruleId) !== 'error')
  // If this list ever empties, the guarantee below has stopped being tested.
  assert.ok(softEvidenceMissing.length >= 2, 'expected warning-severity evidence-missing rules')

  for (const ruleId of softEvidenceMissing) {
    assert.notEqual(severityFor(ruleId), 'error', ruleId)
    assert.equal(
      statusFor([makeFinding(ruleId, 'observed', at('a.json', '/a'))]),
      'incomplete',
      `${ruleId} is only a ${severityFor(ruleId)}, so its place in EVIDENCE_MISSING_RULES is the only thing keeping it off a pass`,
    )
  }

  // The contrast: a warning that is not in the list does pass.
  assert.equal(marksEvidenceMissing('missing-key'), false)
  assert.equal(statusFor([makeFinding('missing-key', 'observed', at('a.json', '/a'))]), 'pass')
  assert.equal(statusFor([makeFinding('redundant-fallback-edge', 'observed', at('a.json', '/a'))]), 'pass')
})

test('missing evidence outranks an error in the same report', () => {
  const findings = [
    makeFinding('required-key-satisfied-by-fallback', 'error here', at('b.json', '/b')),
    makeFinding('catalog-value-not-string', 'unread here', at('a.json', '/a')),
  ]
  assert.equal(statusFor(findings), 'incomplete')
  assert.equal(statusFor([findings[0]]), 'fail')
  assert.equal(statusFor([]), 'pass')
})

test('byCodeUnit orders by code unit, not by collation', () => {
  // 'S' is 0x53 and '_' is 0x5F, so 'aSb' sorts before 'a_b' by code unit.
  // Collation treats the underscore as ignorable punctuation and reverses them.
  assert.equal(byCodeUnit('aSb', 'a_b'), -1)
  assert.equal(byCodeUnit('a_b', 'aSb'), 1)
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.deepEqual(['a_b', 'aSb', 'ab'].sort(byCodeUnit), ['aSb', 'a_b', 'ab'])
})

test('findings sort by file, then pointer, then rule id, then message', () => {
  const findings = [
    makeFinding('missing-key', 'z', at('locales/pt.json', '/locales/1/keys/b')),
    makeFinding('missing-key', 'a', at('locales/pt.json', '/locales/1/keys/b')),
    makeFinding('extra-key', 'q', at('locales/pt.json', '/locales/1/keys/b')),
    makeFinding('missing-key', 'q', at('locales/pt.json', '/locales/1/keys/a')),
    makeFinding('missing-key', 'q', at('locales/de.json', '/locales/9/keys/z')),
  ]
  const sorted = sortFindings(findings)
  assert.deepEqual(
    sorted.map((finding) => [finding.location.file, finding.location.pointer, finding.ruleId, finding.message]),
    [
      ['locales/de.json', '/locales/9/keys/z', 'missing-key', 'q'],
      ['locales/pt.json', '/locales/1/keys/a', 'missing-key', 'q'],
      ['locales/pt.json', '/locales/1/keys/b', 'extra-key', 'q'],
      ['locales/pt.json', '/locales/1/keys/b', 'missing-key', 'a'],
      ['locales/pt.json', '/locales/1/keys/b', 'missing-key', 'z'],
    ],
  )
  // Each key is load bearing on its own: reversing any one of the four changes
  // the order above.
  assert.equal(compareFindings(findings[4], findings[0]), -1, 'file')
  assert.equal(compareFindings(findings[3], findings[0]), -1, 'pointer')
  assert.equal(compareFindings(findings[2], findings[0]), -1, 'ruleId')
  assert.equal(compareFindings(findings[1], findings[0]), -1, 'message')
  assert.equal(sortFindings(findings) !== findings, true, 'sortFindings must not mutate its argument')
})

test('sanitize replaces control and format characters and bounds the length', () => {
  assert.equal(sanitize('legal.terms'), 'legal.terms')
  assert.equal(sanitize('a\nb'), 'a b')
  assert.equal(sanitize('a\r\nb\tc'), 'a b c')
  assert.equal(sanitize(`a${String.fromCharCode(0x2028)}b`), 'a b')
  assert.equal(sanitize(`a${String.fromCharCode(0x2029)}b`), 'a b')
  assert.equal(sanitize(`a${String.fromCharCode(0)}b`), 'a b')
  assert.equal(sanitize(`a${String.fromCharCode(0x202e)}b`), 'a b', 'a bidi override must not survive')
  assert.equal(sanitize(`a${String.fromCharCode(0xfeff)}b`), 'a b')
  assert.equal(sanitize('  padded  '), 'padded')

  const long = 'k'.repeat(500)
  assert.equal(sanitize(long).length, IDENTIFIER_LIMIT)
  assert.equal(sanitize(long).endsWith('...'), true)
  assert.equal(excerpt(long).length, EVIDENCE_LIMIT)
  assert.equal(excerpt('short'), 'short')
  assert.equal(sanitize('k'.repeat(IDENTIFIER_LIMIT)), 'k'.repeat(IDENTIFIER_LIMIT))
})

/**
 * The characters that must never reach output, by class.
 *
 * C0 and the two separators are the obvious half. The C1 range is the half that
 * gets missed: U+0085 is NEL, a line break to a terminal, and U+009B is the
 * 8-bit CSI, the introducer of an ANSI escape sequence. The bidi controls are
 * worse than invisible -- U+202E reverses the text that follows it, so a key
 * can display as something other than what it is.
 */
const CONTROL_CLASSES = {
  'C0 U+0000-U+001F': [0x0000, 0x0001, 0x0008, 0x0009, 0x000a, 0x000d, 0x001b, 0x001f],
  'DEL U+007F': [0x007f],
  'C1 U+0080-U+009F': [0x0080, 0x0085, 0x008d, 0x009b, 0x009f],
  'line and paragraph': [0x2028, 0x2029],
  'bidi': [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069],
  'other format': [0x00ad, 0x061c, 0xfeff],
}

const EVERY_CONTROL = Object.values(CONTROL_CLASSES).flat()

test('every control and format class is replaced, in identifiers as well as excerpts', () => {
  for (const [name, points] of Object.entries(CONTROL_CLASSES)) {
    for (const point of points) {
      const character = String.fromCodePoint(point)
      const label = `${name} U+${point.toString(16).padStart(4, '0')}`
      assert.equal(stripControls(`a${character}b`), 'a b', label)
      assert.equal(sanitize(`a${character}b`), 'a b', label)
      assert.equal(excerpt(`a${character}b`), 'a b', label)
      assert.equal(pointerSegment(`a${character}b`), 'a b', label)

      // The same character arriving through an identifier rather than through
      // an excerpt: a rule id is rejected outright, and a key, a file and a
      // pointer are stripped on the way into the finding.
      assert.throws(() => severityFor(`missing${character}key`), /Unknown ruleId/u, label)
      const finding = makeFinding(
        'missing-key',
        `Key "a${character}b" is missing`,
        at(`locales/a${character}b.json`, `/locales/0/keys/a${character}b`),
        { evidence: `value${character}here`, suggestion: `fix${character}it` },
      )
      for (const field of [finding.message, finding.location.file, finding.location.pointer, finding.evidence, finding.suggestion]) {
        assert.equal(field.includes(character), false, `${label} survived in ${field}`)
      }
    }
  }
})

test('a rule id carrying a control character is named safely when it is refused', () => {
  // The refusal quotes the id it refused, so the refusal itself must be safe.
  const forged = `missing-key${String.fromCodePoint(0x0085)}ERROR forged`
  try {
    severityFor(forged)
    assert.fail('an unknown rule id must throw')
  } catch (thrown) {
    assert.match(thrown.message, /Unknown ruleId/u)
    for (const point of EVERY_CONTROL) {
      assert.equal(thrown.message.includes(String.fromCodePoint(point)), false, point.toString(16))
    }
  }
})

test('stripControls keeps the text but removes what could forge a line', () => {
  assert.equal(stripControls('one\ntwo'), 'one two')
  assert.equal(stripControls('  keeps   spacing  '), '  keeps   spacing  ')
})

test('pointer segments are sanitised and then escaped per RFC 6901', () => {
  assert.equal(pointerSegment('legal.terms'), 'legal.terms')
  assert.equal(pointerSegment('a/b'), 'a~1b')
  assert.equal(pointerSegment('a~b'), 'a~0b')
  assert.equal(pointerSegment('a~/b'), 'a~0~1b')
  assert.equal(pointerSegment('a\nb'), 'a b')
  assert.equal(pointerSegment('a\n/b'), 'a ~1b')
})

test('makeFinding sanitises identifiers, not only the evidence field', () => {
  const finding = makeFinding(
    'missing-key',
    'Key "a\nERROR forged" is missing',
    at('locales/pt\n.json', '/locales/0/keys/a\nb'),
    { evidence: 'value\nwith break', suggestion: 'do\nthis' },
  )
  assert.equal(finding.message.includes('\n'), false)
  assert.equal(finding.location.file.includes('\n'), false)
  assert.equal(finding.location.pointer.includes('\n'), false)
  assert.equal(finding.evidence.includes('\n'), false)
  assert.equal(finding.suggestion.includes('\n'), false)
  assert.equal(finding.severity, 'warning')
})

test('at() omits absent parts rather than emitting nulls', () => {
  assert.deepEqual(at(null, '/locales'), { pointer: '/locales' })
  assert.deepEqual(at('a.json', null), { file: 'a.json' })
  assert.deepEqual(at('a.json', '/x'), { file: 'a.json', pointer: '/x' })
})
