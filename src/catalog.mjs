/**
 * Catalog flattening and interpolation placeholders.
 *
 * A translation catalog is a JSON object. Nested objects are flattened into
 * dotted keys, because that is how the runtimes this tool audits address them:
 * `{"legal": {"terms": "..."}}` is the key `legal.terms`.
 *
 * Two flattening hazards are reported rather than resolved. A catalog that
 * writes both `{"a.b": "x"}` and `{"a": {"b": "y"}}` has two source paths for
 * one key, and which one the runtime serves depends on its loader -- that is
 * missing evidence, not a preference. A nested object deeper than the declared
 * limit is not descended into, and the keys beneath it are named as unread
 * rather than dropped.
 */

import { byCodeUnit } from './rules.mjs'

/**
 * A placeholder is `{name}` where the name is letters, digits, underscore, dot
 * or hyphen. This is the ICU "simple argument" shape, and it is also the inner
 * half of a `{{name}}` mustache, so both are recognised. Nothing else is:
 * `%s`, `$t(...)`, `<0>` and ICU plural or select bodies are out of scope and
 * are documented as such.
 */
const SIMPLE_NAME = String.raw`[A-Za-z0-9_.-]+`

export const PLACEHOLDER_PATTERN = new RegExp(`\\{(${SIMPLE_NAME})\\}`, 'gu')

/** The same name shape, anchored at a position and closing immediately. */
const SIMPLE_ARGUMENT_AT = new RegExp(`${SIMPLE_NAME}\\}`, 'yu')

/**
 * The header of an ICU complex argument: `{count, plural, ...}`, `select` or
 * `selectordinal`.
 *
 * This is why the scan is not a regular expression over the whole value. An ICU
 * branch body is ordinary text in braces -- `{He}`, `{items}`, `{th}` -- which
 * is exactly the simple-argument shape, so a pattern that only looked for
 * `{name}` would read every branch of a correctly translated `select` as a
 * placeholder. The source and the translation then disagree about names that
 * are not placeholders at all, and a correct translation is failed twice over,
 * once as `placeholder-missing` and once as `placeholder-unexpected`.
 *
 * A complex argument is therefore skipped whole, branch bodies and nested
 * arguments included: the docs say these forms are out of scope and report
 * neither a missing nor an unexpected placeholder, and that is what this makes
 * true.
 */
const ICU_COMPLEX_HEADER_AT = new RegExp(
  `\\s*${SIMPLE_NAME}\\s*,\\s*(?:plural|select|selectordinal)\\s*,`,
  'yu',
)

/**
 * The distinct placeholder names in a value, in code unit order.
 *
 * One left-to-right pass with a brace depth counter, so a deeply nested value
 * costs no stack and no rescanning.
 */
export function placeholdersIn(value) {
  const text = String(value)
  const found = new Set()
  let depth = 0
  let skippingFrom = 0

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index)
    if (character === '{') {
      depth += 1
      if (skippingFrom > 0) continue
      ICU_COMPLEX_HEADER_AT.lastIndex = index + 1
      if (ICU_COMPLEX_HEADER_AT.test(text)) {
        skippingFrom = depth
        continue
      }
      SIMPLE_ARGUMENT_AT.lastIndex = index + 1
      const match = SIMPLE_ARGUMENT_AT.exec(text)
      if (match !== null) found.add(match[0].slice(0, -1))
      continue
    }
    if (character !== '}') continue
    if (skippingFrom === depth) skippingFrom = 0
    if (depth > 0) depth -= 1
  }

  return [...found].sort(byCodeUnit)
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function typeNameOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Flatten a parsed catalog.
 *
 * Returns `values` as a Map -- never a plain object -- so a catalog key such as
 * `__proto__` or `constructor` cannot reach an object prototype. The walk is
 * iterative, so a deep document cannot exhaust the call stack before the depth
 * limit is reached.
 *
 * `overflow` means the key limit was passed. The caller must discard the whole
 * catalog and report it: a truncated catalog would make absent keys look like
 * missing translations.
 */
export function flattenCatalog(document, { maxDepth, maxKeys }) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error('maxDepth must be a positive integer')
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error('maxKeys must be a positive integer')

  const values = new Map()
  const seen = new Set()
  const duplicates = []
  const nonStrings = []
  const tooDeep = []
  let keysFound = 0
  let overflow = false

  const stack = [{ prefix: '', node: document, depth: 1 }]
  while (stack.length > 0 && !overflow) {
    const frame = stack.pop()
    for (const [name, value] of Object.entries(frame.node)) {
      const key = frame.prefix === '' ? name : `${frame.prefix}.${name}`
      if (isPlainObject(value)) {
        if (frame.depth + 1 > maxDepth) {
          tooDeep.push(key)
          continue
        }
        stack.push({ prefix: key, node: value, depth: frame.depth + 1 })
        continue
      }
      keysFound += 1
      if (keysFound > maxKeys) {
        overflow = true
        break
      }
      if (seen.has(key)) {
        duplicates.push(key)
        continue
      }
      seen.add(key)
      if (typeof value !== 'string') {
        nonStrings.push({ key, type: typeNameOf(value) })
        continue
      }
      values.set(key, value)
    }
  }

  return {
    values,
    keysFound,
    overflow,
    duplicates: duplicates.sort(byCodeUnit),
    nonStrings: nonStrings.sort((a, b) => byCodeUnit(a.key, b.key)),
    tooDeep: tooDeep.sort(byCodeUnit),
  }
}

/** A value that is absent, or present but blank, is not a translation. */
export function isUsable(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** The keys of a flattened catalog that hold a usable translation. */
export function usableKeys(values) {
  const keys = []
  for (const [key, value] of values) {
    if (isUsable(value)) keys.push(key)
  }
  return keys.sort(byCodeUnit)
}
