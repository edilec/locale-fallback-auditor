import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  RULE_IDS,
  checkProject,
  exitCodeFor,
  marksEvidenceMissing,
  severityFor,
} from '../src/index.mjs'
import { CONFIG_NAME, makeProject, removeProject, ruleFixtures, runCli, ruleIdsOf } from './helpers.mjs'

/**
 * What a severity is for.
 *
 * `RULE_SEVERITY` is the single source of truth, and the catalog, this suite
 * and the documentation are asserted against each other elsewhere. That
 * agreement is not the defence: three declarations edited together still agree,
 * and a rule that used to fail a build would quietly stop doing so.
 *
 * So every rule is pinned by what it does instead. Each fixture in
 * `ruleFixtures()` is a real project driven through the real entry point, and
 * the status and exit code below are written as literals. A downgrade from
 * `error` to `warning` turns one of these runs from fail/1 into pass/0, and a
 * rule dropped from `EVIDENCE_MISSING_RULES` turns incomplete/2 into fail/1.
 * Neither can be edited into agreement, because the observable outcome moves.
 */
const FIXTURES = ruleFixtures()

async function reportFor(t, fixture) {
  const root = await makeProject(fixture.files)
  t.after(() => removeProject(root))
  return { root, report: await checkProject({ config: join(root, CONFIG_NAME) }) }
}

test('every rule in the catalog has exactly one behavioural fixture', () => {
  const covered = FIXTURES.map((fixture) => fixture.ruleId).sort()
  assert.deepEqual(covered, [...RULE_IDS], 'a new rule must bring a fixture that shows what it does')
  assert.equal(new Set(covered).size, covered.length)
})

test('each rule reaches the status and exit code its fixture names', async (t) => {
  for (const fixture of FIXTURES) {
    const { report } = await reportFor(t, fixture)
    assert.deepEqual(ruleIdsOf(report), fixture.expect.rules, `findings of ${fixture.ruleId}`)
    assert.equal(report.status, fixture.expect.status, `status of ${fixture.ruleId}`)
    assert.equal(exitCodeFor(report), fixture.expect.exit, `exit code of ${fixture.ruleId}`)
  }
})

test('the fixture verdicts and the rule catalog describe the same rules', () => {
  for (const fixture of FIXTURES) {
    const { ruleId, expect: expected } = fixture
    const evidenceMissing = expected.status === 'incomplete'
    const fails = expected.status === 'fail'
    if (expected.rules.length === 1) {
      // An isolated fixture: the verdict is this rule's alone, so the catalog
      // must say exactly what the run did.
      assert.equal(marksEvidenceMissing(ruleId), evidenceMissing, `${ruleId} evidence flag`)
      if (!evidenceMissing) {
        assert.equal(severityFor(ruleId) === 'error', fails, `${ruleId} severity decides fail`)
      }
    }
    assert.equal(
      expected.exit,
      expected.status === 'pass' ? 0 : expected.status === 'fail' ? 1 : 2,
      `${ruleId} exit code matches its status`,
    )
  }
})

test('an error rule fails a run that is otherwise clean, and a warning does not', async (t) => {
  const failing = FIXTURES.filter((fixture) => fixture.expect.status === 'fail').map((fixture) => fixture.ruleId)
  const passing = FIXTURES.filter((fixture) => fixture.expect.status === 'pass').map((fixture) => fixture.ruleId)
  // If either list empties, the contrast below has stopped being tested.
  assert.ok(failing.length >= 8, `expected several failing rules, got ${failing.join(', ')}`)
  assert.ok(passing.length >= 5, `expected several passing rules, got ${passing.join(', ')}`)
  for (const ruleId of failing) assert.equal(severityFor(ruleId), 'error', ruleId)
  for (const ruleId of passing) assert.notEqual(severityFor(ruleId), 'error', ruleId)
  for (const ruleId of [...failing, ...passing]) assert.equal(marksEvidenceMissing(ruleId), false, ruleId)
})

test('the real CLI exits with the code each rule implies', async (t) => {
  for (const fixture of FIXTURES) {
    const root = await makeProject(fixture.files)
    t.after(() => removeProject(root))
    const run = await runCli(['--config', join(root, CONFIG_NAME), '--json'], { timeout: 30000 })
    assert.equal(run.killed, false, `${fixture.ruleId} returned`)
    assert.equal(run.code, fixture.expect.exit, `${fixture.ruleId} process exit code`)
    const report = JSON.parse(run.stdout)
    assert.equal(report.status, fixture.expect.status, `${fixture.ruleId} reported status`)
    assert.deepEqual(ruleIdsOf(report), fixture.expect.rules, `${fixture.ruleId} reported findings`)
  }
})
