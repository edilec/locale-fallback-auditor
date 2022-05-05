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
