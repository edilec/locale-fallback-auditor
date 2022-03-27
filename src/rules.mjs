/**
 * The rule catalog.
 *
 * Severity decides whether a run passes or fails, so it is declared exactly
 * once, here, and every finding takes its severity from this table. A finding
 * built with an unknown rule id throws rather than defaulting to something
 * harmless: a one-character typo must not invent a rule that silently cannot
 * fail.
 *
 * `EVIDENCE_MISSING_RULES` is the second half of the same idea. A run whose
 * evidence was missing, truncated, undecodable or uncomparable is `incomplete`,
 * never `pass`, and that is derived from the findings themselves rather than
 * from a separate mutable flag -- there is no single assignment whose deletion
 * would quietly turn an unread catalog into a green build.
 *
 * `catalog-value-not-string` is the rule that makes the distinction load
 * bearing. It is only a `warning`, so its presence in this list is the sole
 * reason a catalog holding a value the auditor cannot compare does not report
 * `pass`.
 */

/** Deterministic order: UTF-16 code unit, never locale collation. */
export function byCodeUnit(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

export const RULE_SEVERITY = Object.freeze({
  'catalog-depth-exceeded': 'error',
  'catalog-key-limit-exceeded': 'error',
  'catalog-not-utf8': 'error',
  'catalog-too-large': 'error',
  'catalog-unparsable': 'error',
  'catalog-unreadable': 'error',
  'catalog-value-not-string': 'warning',
  'duplicate-flattened-key': 'error',
  'empty-translation': 'error',
  'extra-key': 'warning',
  'fallback-cycle': 'error',
  'fallback-depth-exceeded': 'error',
  'fallback-target-unknown': 'error',
  'locale-limit-exceeded': 'error',
  'missing-key': 'warning',
  'no-keys-checked': 'error',
  'no-required-keys-declared': 'warning',
  'placeholder-missing': 'error',
  'placeholder-unexpected': 'error',
  'redundant-fallback-edge': 'info',
  'resolution-not-determined': 'warning',
  'required-key-missing': 'error',
  'required-key-satisfied-by-fallback': 'error',
  'required-key-unknown': 'error',
  'unresolved-key': 'error',
  'untranslated-copy': 'warning',
})

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * Rules that mean the tool did not obtain the evidence it needed. Any one of
 * them makes the whole report `incomplete` and the process exit 2, whatever the
 * rule's own severity is.
 */
export const EVIDENCE_MISSING_RULES = Object.freeze([
  'catalog-depth-exceeded',
  'catalog-key-limit-exceeded',
  'catalog-not-utf8',
  'catalog-too-large',
  'catalog-unparsable',
  'catalog-unreadable',
  'catalog-value-not-string',
  'duplicate-flattened-key',
  'fallback-depth-exceeded',
  'fallback-target-unknown',
  'locale-limit-exceeded',
  'no-keys-checked',
  'resolution-not-determined',
].sort(byCodeUnit))

const EVIDENCE_MISSING_SET = new Set(EVIDENCE_MISSING_RULES)

export const EVIDENCE_LIMIT = 200
export const IDENTIFIER_LIMIT = 120

/**
 * Every untrusted string that reaches the report -- a translation key, a locale
 * id, a file name, an excerpt -- passes through here first.
 *
 * Control and format characters are replaced rather than kept. A key holding a
 * newline would otherwise forge a line in the human summary, and a bidi
 * override would reorder one; neither is a hypothetical, both arrive inside
 * ordinary-looking JSON catalogs.
 */
const CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

export function stripControls(text) {
  return String(text).replace(CONTROL_PATTERN, ' ')
}

export function sanitize(text, limit = IDENTIFIER_LIMIT) {
  const flat = stripControls(text).replace(/\s+/gu, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 3)}...`
}

/** A bounded, redacted excerpt of untrusted input. */
export function excerpt(text) {
  return sanitize(text, EVIDENCE_LIMIT)
}

/**
 * One JSON Pointer segment. Sanitised first, then escaped per RFC 6901, so a
 * key containing a slash cannot forge pointer structure.
 */
export function pointerSegment(value) {
  return sanitize(value).replace(/~/gu, '~0').replace(/\//gu, '~1')
}

export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${sanitize(ruleId)}"`)
  return severity
}

export function marksEvidenceMissing(ruleId) {
  severityFor(ruleId)
  return EVIDENCE_MISSING_SET.has(ruleId)
}

export function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = stripControls(file)
  if (pointer !== null && pointer !== undefined) location.pointer = stripControls(pointer)
  return location
}

/**
 * Build a finding. `message` is passed through the control stripper as a last
 * line of defence: call sites bound their own interpolations with `sanitize`,
 * and this makes a forgotten one harmless rather than exploitable.
 */
export function makeFinding(ruleId, message, location, extra = {}) {
  const finding = {
    ruleId,
    severity: severityFor(ruleId),
    message: stripControls(message),
    location,
  }
  if (extra.evidence !== undefined) finding.evidence = excerpt(extra.evidence)
  if (extra.suggestion !== undefined) finding.suggestion = stripControls(extra.suggestion)
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/**
 * Status is a function of the findings, so no separate flag can be deleted to
 * turn an unread catalog into a pass.
 */
export function statusFor(findings) {
  for (const finding of findings) {
    if (EVIDENCE_MISSING_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
