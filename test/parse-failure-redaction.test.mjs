import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { parseFailureDetail } from '../src/rules.mjs'
import { CONFIG_NAME, healthyCatalogs, makeProject, regionalProject, removeProject, runCli } from './helpers.mjs'

/**
 * A parse failure does not quote the document it failed on.
 *
 * V8 reports a parse failure two ways, and one of them embeds the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`.
 * `catalog-unparsable` put that message in the report on stdout and the config
 * loader put it on stderr, so a catalog or a config short enough to be nothing
 * but a credential was reproduced in full -- on exactly the path a malformed or
 * untrusted file takes. `sanitize` never helped and never could: it cuts from
 * the end and the quoted span is at the front.
 *
 * The canary is the AWS documentation placeholder, not a key. Every assertion
 * walks it down to eight characters, because V8 quotes a ten-character window
 * once the input is long enough: asserting only the whole string passes while
 * ten characters of the secret still ship.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

/** Every prefix of the canary from eight characters to its full length. */
function assertNoPrefix({ stdout, stderr }) {
  for (let length = SHORTEST_PREFIX; length <= CANARY.length; length += 1) {
    const prefix = CANARY.slice(0, length)
    assert.equal(stdout.includes(prefix), false, `stdout carried the first ${length} characters of the canary`)
    assert.equal(stderr.includes(prefix), false, `stderr carried the first ${length} characters of the canary`)
  }
}

/** Run the real binary over a project whose `pt` catalog is the given text. */
async function withUnparsableCatalog(text, body) {
  const files = regionalProject({ catalogs: healthyCatalogs() })
  files['locales/pt.json'] = text
  const root = await makeProject(files)
  try {
    const result = await runCli(['--config', join(root, CONFIG_NAME)])
    assertNoPrefix(result)
    return await body(result)
  } finally {
    await removeProject(root)
  }
}

test('a catalog that is only a credential is not echoed by its own parse error', async () => {
  await withUnparsableCatalog(CANARY, ({ code, stdout }) => {
    assert.equal(code, 2)
    const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'catalog-unparsable')
    assert.notEqual(finding, undefined, 'the run still said the catalog was not JSON')
    assert.match(finding.message, /token/, 'the diagnostic still says what went wrong')
  })
})

test('a catalog that fails after a valid property keeps its position, line and column', async () => {
  // V8 answers this one with the safe spelling: a position and no quoted span.
  // A parse error that says nothing is a different defect.
  await withUnparsableCatalog(`{"legal": {} ${CANARY}}`, ({ stdout }) => {
    const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'catalog-unparsable')
    assert.match(finding.message, /at position \d+/, 'the position a reader needs is still there')
    assert.match(finding.message, /line \d+ column \d+/, 'line and column are still there')
  })
})

test('a secret deep inside a longer catalog is not echoed by the windowed spelling', async () => {
  // The third V8 spelling quotes a window rather than a prefix and carries no
  // position; only the offending token survives it.
  await withUnparsableCatalog(`{"legal": {"terms": "Accept."}, "checkout": ${CANARY}}`, ({ stdout }) => {
    const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'catalog-unparsable')
    assert.match(finding.message, /unexpected token/)
  })
})

test('a config that is only a credential is not echoed on stderr', async () => {
  const root = await makeProject({ [CONFIG_NAME]: CANARY })
  try {
    const result = await runCli(['--config', join(root, CONFIG_NAME)])
    assert.equal(result.code, 2)
    assertNoPrefix(result)
    assert.match(result.stderr, /not valid JSON/, 'the refusal still says why the config was refused')
  } finally {
    await removeProject(root)
  }
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const caught = (text) => {
    try {
      JSON.parse(text)
      return null
    } catch (error) {
      return error
    }
  }

  const quoted = caught(CANARY)
  assert.equal(quoted.message.includes(CANARY), true, 'V8 still quotes the input, so this test still has a subject')
  assert.equal(parseFailureDetail(quoted).includes(CANARY.slice(0, SHORTEST_PREFIX)), false)

  const detail = parseFailureDetail(caught(`{"a": 1 ${CANARY}}`))
  assert.equal(detail.includes(CANARY.slice(0, SHORTEST_PREFIX)), false)
  assert.match(detail, /at position \d+ \(line \d+ column \d+\)$/)

  assert.equal(parseFailureDetail(caught('password=hunter2-correct-horse')).includes('password'), false)
  assert.equal(parseFailureDetail(caught('')), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})

/**
 * Ordering pin: the quoting shape must be recognised BEFORE the offset.
 *
 * A helper that searches for `at position` first finds that phrase inside the
 * quoted span whenever the document itself supplies it, and slices the
 * document straight back out. The first case below is the one that bites when
 * the two branches are swapped back, and it takes two assertions to bite:
 * whether the document survives, AND whether the diagnostic does. The closing
 * double-quote guard turns a reverted ordering into the generic sentence
 * rather than a leak, so a test that only looked for the leak would sit green
 * over a helper that had stopped saying anything at all about this document.
 *
 * The last two cases pin that same opposite failure for the shapes V8 writes
 * without a quoted span. A helper that answered every message generically
 * would leak nothing and diagnose nothing.
 */

const ORDERING_SECRET = 'sk-live-9f2c1b7a4d'

/** The detail this tool produces for a document V8 refuses. */
function detailOfParseFailure(text) {
  try {
    JSON.parse(text)
  } catch (error) {
    return parseFailureDetail(error)
  }
  throw new Error(`${JSON.stringify(text)} parsed, so it pins nothing`)
}

/** What V8 actually said, so a case cannot quietly stop having a subject. */
function messageOfParseFailure(text) {
  try {
    JSON.parse(text)
  } catch (error) {
    return error.message
  }
  throw new Error(`${JSON.stringify(text)} parsed, so it pins nothing`)
}

test('a document that merely CONTAINS "at position" is not sliced back out', () => {
  const document = 'at position 1'
  assert.match(
    messageOfParseFailure(document),
    /"at position 1"/,
    'V8 still quotes this document back, so this case still has a subject',
  )

  const detail = detailOfParseFailure(document)
  assert.equal(detail.includes('"'), false, `a double quote survived: ${JSON.stringify(detail)}`)
  assert.equal(detail.includes(document), false, `the document survived: ${JSON.stringify(detail)}`)
  assert.match(
    detail,
    /unexpected token 'a'/,
    'the offending token is still named -- searching for the offset first loses it here',
  )
})

test('a document that is nothing but a credential-shaped token is not echoed', () => {
  const detail = detailOfParseFailure(ORDERING_SECRET)
  assert.equal(detail.includes(ORDERING_SECRET), false, `the token survived: ${JSON.stringify(detail)}`)
  assert.equal(detail.includes('"'), false)
})

test('no four-character prefix of a long sensitive document reaches the detail', () => {
  // Long enough that V8 quotes a ten-character window rather than the whole
  // document: asserting only on the whole string would pass while ten
  // characters of the secret still shipped.
  const detail = detailOfParseFailure(`${ORDERING_SECRET}${'x'.repeat(400)}`)
  for (let length = 4; length <= 10; length += 1) {
    assert.equal(
      detail.includes(ORDERING_SECRET.slice(0, length)),
      false,
      `the first ${length} characters of the document survived: ${JSON.stringify(detail)}`,
    )
  }
  assert.equal(detail.includes('"'), false)
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  // Without the `s` flag the quoted-span pattern does not match this message
  // at all and the document falls through to a branch that keeps it.
  const detail = detailOfParseFailure('}x\n')
  assert.match(detail, /unexpected token/)
  assert.equal(detail.includes('"'), false, `a double quote survived: ${JSON.stringify(detail)}`)
})

test('the genuinely safe positional form keeps its position, line and column', () => {
  const detail = detailOfParseFailure('{"a": 1 "b": 2}')
  assert.match(detail, /at position 8/)
  assert.match(detail, /line 1 column 9/)
})

test('"Unexpected end of JSON input" passes through unchanged', () => {
  assert.equal(detailOfParseFailure(''), 'Unexpected end of JSON input')
})
