/**
 * locale-fallback-auditor
 *
 * Read a set of translation catalogs and the fallback graph that joins them,
 * then report the three things a fallback graph quietly gets wrong: content
 * that requires a real translation but is served from another locale, an
 * interpolation placeholder that the source and the translation disagree
 * about, and a fallback cycle.
 *
 * Nothing is fetched. Every catalog comes from a file the configuration named,
 * inside a declared input root that the configuration cannot escape, lexically
 * or through a symbolic link. A catalog that could not be read, decoded, parsed
 * or compared is reported as missing evidence -- `incomplete` and exit 2 --
 * never as a pass, and never as a verdict about content nobody read.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { auditCatalogs, auditGraph } from './audit.mjs'
import { flattenCatalog, isPlainObject, usableKeys } from './catalog.mjs'
import { analyzeGraph, buildGraph, cycleKey, localeKey, resolutionOrder } from './graph.mjs'
import {
  EVIDENCE_MISSING_RULES,
  RULE_IDS,
  RULE_SEVERITY,
  at,
  byCodeUnit,
  excerpt,
  makeFinding,
  marksEvidenceMissing,
  parseFailureDetail,
  pointerSegment,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'

export { auditCatalogs, auditGraph, requiredMatcher, resolveKey } from './audit.mjs'
export {
  PLACEHOLDER_PATTERN,
  flattenCatalog,
  isPlainObject,
  isUsable,
  placeholdersIn,
  typeNameOf,
  usableKeys,
} from './catalog.mjs'
export { analyzeGraph, buildGraph, cycleKey, localeKey, resolutionOrder } from './graph.mjs'
export {
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
  makeFinding,
  marksEvidenceMissing,
  parseFailureDetail,
  pointerSegment,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
  stripControls,
} from './rules.mjs'

export const TOOL_ID = 'locale-fallback-auditor'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

/** Every limit here is enforced; exceeding one is a finding, never a truncation. */
export const DEFAULT_LIMITS = Object.freeze({
  maxCatalogBytes: 4000000,
  maxCatalogDepth: 12,
  maxFallbackDepth: 16,
  maxKeysPerCatalog: 20000,
  maxLocales: 200,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS).sort(byCodeUnit))

/** Fixed bounds. They are not configurable, and they are still enforced. */
export const MAX_CONFIG_BYTES = 1000000
export const MAX_PATH_LENGTH = 200

/**
 * A locale id is an ASCII BCP 47 shaped token. Validating it at the door means
 * the ids that appear in pointers and messages cannot carry a newline or a bidi
 * override; every other untrusted string is sanitised on the way out instead.
 */
export const LOCALE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,34}$/u

const CONFIG_KEYS = Object.freeze([
  'schemaVersion',
  'sourceLocale',
  'locales',
  'requiredKeys',
  'requiredKeyPrefixes',
  'limits',
])
const LOCALE_KEYS = Object.freeze(['id', 'catalog', 'fallback'])

/** A problem with the configuration itself, not with the catalogs being audited. */
export class ConfigError extends Error {
  constructor(message, rule = null) {
    super(message)
    this.name = 'ConfigError'
    this.rule = rule
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toPosix(value) {
  return value.split(sep).join('/')
}

function escapes(from, target) {
  const rel = relative(from, target)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * The real path a target has once every symbolic link on the way to it is
 * followed.
 *
 * `realpath` needs the whole path to exist, but a catalog that was never
 * written must still reach the report as `catalog-unreadable` rather than as a
 * configuration error. So the deepest existing ancestor is resolved for real
 * and the missing segments are appended literally: a link anywhere along the
 * part that does exist is still followed.
 */
async function realPathOf(target, describe) {
  const tail = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : resolve(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new ConfigError(
          `${describe} could not be resolved (${error.code ?? 'unknown error'})`,
          'input-unresolvable',
        )
      }
      const parent = dirname(current)
      if (parent === current) return target
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve a configured input path, refusing to leave the declared root.
 *
 * The lexical check is not the boundary. A symbolic link planted inside the
 * root points wherever it likes, and following one would read a file the
 * configuration never had the right to name and echo its contents into the
 * report. So the path is confined again after every link on it has been
 * followed, against the *real* path of the root -- the root may itself sit
 * behind a link, as `/var` does on macOS, and comparing a real target against a
 * symbolic root would refuse files that are genuinely inside it.
 */
export async function resolveWithin(root, realRoot, candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ConfigError(`${label} must be a non-empty relative path`, 'input-not-relative')
  }
  if (candidate.length > MAX_PATH_LENGTH) {
    throw new ConfigError(
      `${label} is ${candidate.length} characters, over the ${MAX_PATH_LENGTH} character path limit`,
      'input-too-long',
    )
  }
  if (isAbsolute(candidate)) {
    throw new ConfigError(
      `${label} must be relative to the input root, but "${sanitize(candidate)}" is absolute`,
      'input-not-relative',
    )
  }
  const resolved = resolve(root, candidate)
  if (escapes(root, resolved)) {
    throw new ConfigError(`${label} resolves outside the input root: "${sanitize(candidate)}"`, 'input-outside-root')
  }
  const real = await realPathOf(resolved, `${label} ("${sanitize(candidate)}")`)
  if (escapes(realRoot, real)) {
    throw new ConfigError(
      `${label} leaves the input root through a symbolic link: "${sanitize(candidate)}". Nothing was read from it.`,
      'input-escapes-root',
    )
  }
  return resolved
}

function validateStringList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigError(`${label} must be an array of strings`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(`${label}[${index}] must be a non-empty string`)
    }
    return entry
  })
}

export function validateConfig(document, overrides = {}) {
  if (!isRecord(document)) throw new ConfigError('Config must be a JSON object')
  for (const key of Object.keys(document)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new ConfigError(`Unknown config key "${sanitize(key)}". Known keys: ${CONFIG_KEYS.join(', ')}`)
    }
  }
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported config schemaVersion: ${sanitize(document.schemaVersion ?? 'missing')}`)
  }

  if (!Array.isArray(document.locales) || document.locales.length === 0) {
    throw new ConfigError('locales must be a non-empty array')
  }

  const byLowerId = new Map()
  const locales = document.locales.map((entry, index) => {
    if (!isRecord(entry)) throw new ConfigError(`locales[${index}] must be an object`)
    for (const key of Object.keys(entry)) {
      if (!LOCALE_KEYS.includes(key)) {
        throw new ConfigError(`Unknown key "${sanitize(key)}" in locales[${index}]. Known keys: ${LOCALE_KEYS.join(', ')}`)
      }
    }
    if (typeof entry.id !== 'string' || !LOCALE_ID_PATTERN.test(entry.id)) {
      throw new ConfigError(
        `locales[${index}].id must be an ASCII locale tag of 1 to 35 characters, got "${sanitize(entry.id ?? 'missing', 40)}"`,
      )
    }
    const key = localeKey(entry.id)
    if (byLowerId.has(key)) {
      throw new ConfigError(
        `locales[${index}].id "${sanitize(entry.id, 40)}" repeats locales[${byLowerId.get(key)}].id; locale tags are case insensitive`,
      )
    }
    byLowerId.set(key, index)
    if (typeof entry.catalog !== 'string' || entry.catalog.trim() === '') {
      throw new ConfigError(`locales[${index}].catalog must name the catalog file for this locale`)
    }
    const fallback = validateStringList(entry.fallback, `locales[${index}].fallback`)
    for (const [position, target] of fallback.entries()) {
      if (!LOCALE_ID_PATTERN.test(target)) {
        throw new ConfigError(
          `locales[${index}].fallback[${position}] must be an ASCII locale tag, got "${sanitize(target, 40)}"`,
        )
      }
    }
    return { index, id: entry.id, key, catalog: entry.catalog, fallback }
  })

  if (typeof document.sourceLocale !== 'string' || document.sourceLocale.trim() === '') {
    throw new ConfigError('sourceLocale must name the locale the key set comes from')
  }
  const sourceKey = localeKey(document.sourceLocale)
  if (!byLowerId.has(sourceKey)) {
    throw new ConfigError(`sourceLocale "${sanitize(document.sourceLocale, 40)}" is not one of the declared locales`)
  }

  const requiredKeys = validateStringList(document.requiredKeys, 'requiredKeys')
  const declaredPrefixes = validateStringList(document.requiredKeyPrefixes, 'requiredKeyPrefixes')
  const extraPrefixes = validateStringList(overrides.requirePrefixes, '--require-prefix')
  const requiredKeyPrefixes = [...declaredPrefixes, ...extraPrefixes]

  const limits = { ...DEFAULT_LIMITS }
  if (document.limits !== undefined) {
    if (!isRecord(document.limits)) throw new ConfigError('limits must be an object')
    for (const [name, value] of Object.entries(document.limits)) {
      if (!LIMIT_NAMES.includes(name)) {
        throw new ConfigError(`Unknown limit "${sanitize(name)}". Known limits: ${LIMIT_NAMES.join(', ')}`)
      }
      if (!Number.isInteger(value) || value < 1) throw new ConfigError(`limits.${name} must be a positive integer`)
      limits[name] = value
    }
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    sourceLocale: locales[byLowerId.get(sourceKey)].id,
    sourceKey,
    locales,
    requiredKeys,
    requiredKeyPrefixes,
    limits,
  }
}

/**
 * Read a file as UTF-8, strictly.
 *
 * `fatal: true` is the whole point: a file whose bytes are not UTF-8 is
 * reported as undecodable, and encoding validity is never inferred from the
 * decoded text. A catalog that legitimately contains U+FFFD is not evidence of
 * anything.
 */
async function readTextBounded(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  if (!info.isFile()) return { status: 'unreadable', reason: 'not a regular file', text: null }
  if (info.size > maxBytes) {
    return { status: 'too-large', reason: `${info.size} bytes exceeds the ${maxBytes} byte limit`, text: null }
  }
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { status: 'not-utf8', reason: 'the bytes are not valid UTF-8', text: null }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { status: 'ok', reason: null, text }
}

async function loadCatalogs(config, root, realRoot, findings) {
  const catalogs = new Map()

  for (const locale of config.locales) {
    const pointer = `/locales/${locale.index}/catalog`
    const absolute = await resolveWithin(root, realRoot, locale.catalog, `locales[${locale.index}].catalog`)
    const file = toPosix(relative(root, absolute))
    const label = `The catalog for locale "${sanitize(locale.id, 40)}"`
    const read = await readTextBounded(absolute, config.limits.maxCatalogBytes)
    if (read.status === 'unreadable') {
      findings.push(makeFinding('catalog-unreadable', `${label} could not be read (${read.reason}).`, at(file, pointer), {
        suggestion: 'Export the catalog before auditing, or correct locales[].catalog.',
      }))
      continue
    }
    if (read.status === 'too-large') {
      findings.push(makeFinding('catalog-too-large', `${label} was not read: ${read.reason}.`, at(file, pointer), {
        suggestion: 'Raise limits.maxCatalogBytes deliberately, or split the catalog.',
      }))
      continue
    }
    if (read.status === 'not-utf8') {
      findings.push(makeFinding('catalog-not-utf8', `${label} was not decoded: ${read.reason}.`, at(file, pointer), {
        suggestion: 'Write the catalog as UTF-8.',
      }))
      continue
    }

    let document
    try {
      document = JSON.parse(read.text)
    } catch (error) {
      findings.push(makeFinding('catalog-unparsable', `${label} is not valid JSON: ${sanitize(parseFailureDetail(error))}.`, at(file, pointer), {
        suggestion: 'Correct the JSON syntax.',
      }))
      continue
    }
    if (!isPlainObject(document)) {
      findings.push(makeFinding('catalog-unparsable', `${label} is not a JSON object at the top level.`, at(file, pointer), {
        suggestion: 'Wrap the catalog in an object of key to translated string.',
      }))
      continue
    }

    const flat = flattenCatalog(document, {
      maxDepth: config.limits.maxCatalogDepth,
      maxKeys: config.limits.maxKeysPerCatalog,
    })
    if (flat.overflow) {
      findings.push(makeFinding(
        'catalog-key-limit-exceeded',
        `${label} holds more than ${config.limits.maxKeysPerCatalog} keys, over the limit; none of them were audited.`,
        at(file, pointer),
        { suggestion: 'Raise limits.maxKeysPerCatalog deliberately, or split the catalog.' },
      ))
      continue
    }
    for (const key of flat.tooDeep) {
      findings.push(makeFinding(
        'catalog-depth-exceeded',
        `${label} nests "${sanitize(key)}" deeper than limits.maxCatalogDepth (${config.limits.maxCatalogDepth}); the keys under it were not read.`,
        at(file, `/locales/${locale.index}/keys/${pointerSegment(key)}`),
        { suggestion: 'Raise limits.maxCatalogDepth deliberately, or flatten the catalog.' },
      ))
    }
    for (const key of flat.duplicates) {
      findings.push(makeFinding(
        'duplicate-flattened-key',
        `${label} reaches "${sanitize(key)}" by two different paths, so which value a loader serves is unknown. The first was kept.`,
        at(file, `/locales/${locale.index}/keys/${pointerSegment(key)}`),
        { suggestion: 'Write the key once, either dotted or nested.' },
      ))
    }
    for (const entry of flat.nonStrings) {
      findings.push(makeFinding(
        'catalog-value-not-string',
        `${label} holds a ${entry.type} at "${sanitize(entry.key)}". Only strings are compared, so this key was not audited.`,
        at(file, `/locales/${locale.index}/keys/${pointerSegment(entry.key)}`),
        { suggestion: 'Store the translation as a string, or remove the key.' },
      ))
    }

    catalogs.set(locale.key, { file, values: flat.values })
  }

  return catalogs
}

export function buildReport(findings, counts) {
  const sorted = sortFindings(findings)
  const summary = {
    checked: counts.checked,
    errors: sorted.filter((finding) => finding.severity === 'error').length,
    warnings: sorted.filter((finding) => finding.severity === 'warning').length,
    info: sorted.filter((finding) => finding.severity === 'info').length,
    locales: counts.locales,
    audited: counts.audited,
    keys: counts.keys,
    requiredKeys: counts.requiredKeys,
    undetermined: counts.undetermined,
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(sorted),
    summary,
    findings: sorted,
  }
}

/**
 * Audit one project.
 *
 * Throws `ConfigError` when the run never had a subject: a bad config, an
 * unknown key, a path that leaves the input root. Everything that went wrong
 * with the evidence itself comes back inside the report.
 */
export async function checkProject({ config, root, requirePrefixes }) {
  const configPath = resolve(process.cwd(), config)
  let raw
  try {
    raw = await readFile(configPath)
  } catch (error) {
    throw new ConfigError(`Could not load the config (${error.code ?? error.message})`)
  }
  if (raw.byteLength > MAX_CONFIG_BYTES) {
    throw new ConfigError(`The config is ${raw.byteLength} bytes, over the ${MAX_CONFIG_BYTES} byte limit`)
  }
  let text
  try {
    // The config is decoded exactly as strictly as the catalogs are. A tool
    // that hardens its data path and leaves its own config path lossy has a
    // hole, not a policy.
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new ConfigError('The config could not be decoded as UTF-8')
  }
  let document
  try {
    document = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    throw new ConfigError(`The config is not valid JSON: ${sanitize(parseFailureDetail(error))}`)
  }

  const validated = validateConfig(document, { requirePrefixes })

  const inputRoot = root === undefined || root === null ? dirname(configPath) : resolve(process.cwd(), root)
  let realRoot
  try {
    realRoot = await realpath(inputRoot)
  } catch (error) {
    throw new ConfigError(`The input root could not be resolved (${error.code ?? 'unknown error'})`, 'input-unresolvable')
  }

  const emptyCounts = {
    checked: 0,
    locales: validated.locales.length,
    audited: 0,
    keys: 0,
    requiredKeys: 0,
    undetermined: 0,
  }

  if (validated.locales.length > validated.limits.maxLocales) {
    return buildReport([makeFinding(
      'locale-limit-exceeded',
      `The config declares ${validated.locales.length} locales, over the limit of ${validated.limits.maxLocales}; nothing was read.`,
      at(null, '/locales'),
      { suggestion: 'Raise limits.maxLocales deliberately, or audit fewer locales at a time.' },
    )], emptyCounts)
  }

  const findings = []
  const catalogs = await loadCatalogs(validated, inputRoot, realRoot, findings)

  const graph = buildGraph(validated.locales)
  const analysis = analyzeGraph(graph, { maxDepth: validated.limits.maxFallbackDepth })
  findings.push(...auditGraph(graph, analysis))

  const audit = auditCatalogs({
    locales: validated.locales,
    catalogs,
    sourceKey: validated.sourceKey,
    orders: analysis.orders,
    truncatedChains: analysis.truncated,
    required: { keys: validated.requiredKeys, prefixes: validated.requiredKeyPrefixes },
  })
  findings.push(...audit.findings)

  if (audit.checked === 0 && !findings.some((finding) => marksEvidenceMissing(finding.ruleId))) {
    findings.push(makeFinding(
      'no-keys-checked',
      'No key was resolved in any locale, so there is no evidence to pass or fail on.',
      at(null, '/locales'),
      { suggestion: 'Give the source locale a catalog with at least one translated key.' },
    ))
  }

  return buildReport(findings, {
    checked: audit.checked,
    locales: validated.locales.length,
    audited: audit.audited,
    keys: audit.keys,
    requiredKeys: audit.requiredKeys,
    undetermined: audit.undetermined,
  })
}

/**
 * Serialise the report for stdout.
 *
 * `JSON.stringify` leaves the line separator and paragraph separator raw, and
 * inside a JavaScript string literal those two are line terminators. The
 * payload parses as JSON either way, but a translation key carrying one would
 * break a consumer that evaluates the payload as JavaScript, so both are
 * escaped here. Nothing else about the text changes.
 */
const BACKSLASH = '\\'

export function renderReport(report) {
  const json = JSON.stringify(report, null, 2)
    .replace(/\p{Zl}/gu, `${BACKSLASH}u2028`)
    .replace(/\p{Zp}/gu, `${BACKSLASH}u2029`)
  return `${json}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}

/** A human summary. It goes to stderr, because stdout carries only the report. */
export function formatSummary(report) {
  const lines = report.findings.map((finding) => {
    const where = [finding.location.file, finding.location.pointer].filter(Boolean).join(' ')
    return `${finding.severity.toUpperCase().padEnd(7)} ${finding.ruleId.padEnd(34)} ${where}`
  })
  lines.push('')
  lines.push(
    `${report.summary.audited} of ${report.summary.locales} locale(s) audited, `
    + `${report.summary.keys} source key(s), ${report.summary.requiredKeys} requiring translation, `
    + `${report.summary.checked} resolution(s) checked, ${report.summary.undetermined} undetermined.`,
  )
  lines.push(
    `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info. `
    + `Status ${report.status}.`,
  )
  return `${lines.join('\n')}\n`
}

/** Exported so the rule catalog can be asserted against the documentation. */
export const CATALOG = Object.freeze({
  ruleIds: RULE_IDS,
  severity: RULE_SEVERITY,
  evidenceMissing: EVIDENCE_MISSING_RULES,
  limits: DEFAULT_LIMITS,
  severityFor,
  excerpt,
  usableKeys,
  cycleKey,
  resolutionOrder,
})
