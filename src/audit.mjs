/**
 * The audit itself: pure functions over already-loaded catalogs.
 *
 * Nothing here touches the filesystem, so every rule can be exercised from a
 * literal fixture.
 *
 * The rule this tool exists for is `required-key-satisfied-by-fallback`. A key
 * marked as requiring translation is satisfied only by the locale's own
 * catalog. When a fallback supplies it, the page still renders -- which is
 * exactly the problem, because legal text, product names and regulated copy are
 * then served to a reader in a language they did not ask for, with nothing on
 * the page to show it. The finding names both the key and the locale the text
 * would have come from.
 *
 * The second rule about honesty is `resolution-not-determined`. When a locale's
 * fallback chain contains a catalog that could not be read, an undeclared
 * target, or an edge past the depth limit, the keys beyond that point have no
 * known answer. They are reported as undetermined, never as resolved and never
 * as missing.
 */

import { isUsable, placeholdersIn, usableKeys } from './catalog.mjs'
import { at, byCodeUnit, excerpt, makeFinding, pointerSegment, sanitize } from './rules.mjs'

/**
 * A key requires translation when it is named exactly, or when it sits under a
 * declared prefix. `legal` covers `legal` and `legal.terms`, and deliberately
 * does not cover `legalese`.
 */
export function requiredMatcher({ keys = [], prefixes = [] } = {}) {
  const exact = new Set(keys)
  const under = [...prefixes]
  return (key) => exact.has(key) || under.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))
}

function keyPointer(locale, key) {
  return `/locales/${locale.index}/keys/${pointerSegment(key)}`
}

/** Findings about the shape of the fallback graph itself. */
export function auditGraph(graph, analysis) {
  const findings = []

  for (const cycle of analysis.cycles) {
    const trail = cycle.members.map((id) => sanitize(id, 40)).join(' -> ')
    const entry = graph.get(cycle.members[0].toLowerCase())
    findings.push(makeFinding(
      'fallback-cycle',
      `The fallback graph contains a cycle: ${trail}. Resolution stops at the repeat, so the locales in the cycle can never reach anything beyond it.`,
      at(null, `/locales/${entry === undefined ? 0 : entry.index}/fallback`),
      {
        evidence: trail,
        suggestion: 'Break the cycle so every chain ends at a locale that falls back to nothing.',
      },
    ))
  }

  for (const edge of analysis.unknown) {
    const node = graph.get(edge.fromKey)
    findings.push(makeFinding(
      'fallback-target-unknown',
      `Locale "${sanitize(node.id, 40)}" falls back to "${sanitize(edge.target, 40)}", which is not a declared locale. What that fallback would serve is unknown.`,
      at(null, `/locales/${node.index}/fallback/${edge.edgeIndex}`),
      { suggestion: 'Declare the target locale, or remove the edge.' },
    ))
  }

  for (const edge of analysis.depthExceeded) {
    const node = graph.get(edge.fromKey)
    const start = graph.get(edge.startKey)
    findings.push(makeFinding(
      'fallback-depth-exceeded',
      `Resolving "${sanitize(start.id, 40)}" reached depth ${edge.depth} at "${sanitize(node.id, 40)}", over the configured limit. The rest of that chain was not followed.`,
      at(null, `/locales/${node.index}/fallback/${edge.edgeIndex}`),
      { suggestion: 'Raise limits.maxFallbackDepth deliberately, or shorten the chain.' },
    ))
  }

  for (const edge of analysis.redundant) {
    const node = graph.get(edge.fromKey)
    const target = graph.get(edge.target)
    findings.push(makeFinding(
      'redundant-fallback-edge',
      `Locale "${sanitize(node.id, 40)}" lists "${sanitize(target.id, 40)}" as a fallback, but an earlier entry already reaches it. The edge changes nothing.`,
      at(null, `/locales/${node.index}/fallback/${edge.edgeIndex}`),
      { suggestion: 'Remove the entry, or reorder the list if a different precedence was intended.' },
    ))
  }

  return findings
}

/**
 * Walk one locale's resolution order for one key.
 *
 * Returns `{ state: 'self' | 'fallback' | 'absent' | 'undetermined', at }`.
 * `undetermined` is returned as soon as the walk reaches a locale whose catalog
 * was not loaded, and when the walk finishes without an answer but the chain
 * was truncated. Either way the key has no verdict, which is not the same as
 * having a negative one.
 */
export function resolveKey(key, order, catalogs, chainTruncated) {
  for (let index = 0; index < order.length; index += 1) {
    const localeKeyAt = order[index]
    const catalog = catalogs.get(localeKeyAt)
    if (catalog === undefined) return { state: 'undetermined', at: localeKeyAt }
    if (isUsable(catalog.values.get(key))) {
      return { state: index === 0 ? 'self' : 'fallback', at: localeKeyAt }
    }
  }
  return chainTruncated ? { state: 'undetermined', at: null } : { state: 'absent', at: null }
}

/**
 * Audit every loaded catalog against the source locale.
 *
 * `locales` is the declared list. `catalogs` holds only the locales whose
 * catalog was read, decoded, parsed and flattened; a locale missing from it has
 * already produced an evidence-missing finding upstream and is not guessed at
 * here.
 */
export function auditCatalogs({ locales, catalogs, sourceKey, orders, truncatedChains, required }) {
  const findings = []
  const byKey = new Map(locales.map((locale) => [locale.key, locale]))
  const source = catalogs.get(sourceKey)
  if (source === undefined) {
    return { findings, checked: 0, keys: 0, requiredKeys: 0, undetermined: 0, audited: 0 }
  }

  const sourceLocale = byKey.get(sourceKey)
  const sourceKeys = usableKeys(source.values)
  const sourceKeySet = new Set(sourceKeys)
  const isRequired = requiredMatcher(required)

  if (required.keys.length === 0 && required.prefixes.length === 0) {
    findings.push(makeFinding(
      'no-required-keys-declared',
      'No key is marked as requiring translation, so the check that a fallback never satisfies required content had no subject.',
      at(null, '/requiredKeys'),
      { suggestion: 'List the legal, product and regulated keys in requiredKeys or requiredKeyPrefixes.' },
    ))
  }

  for (const [index, name] of required.keys.entries()) {
    if (sourceKeySet.has(name)) continue
    findings.push(makeFinding(
      'required-key-unknown',
      `requiredKeys names "${sanitize(name)}", which the source locale "${sanitize(sourceLocale.id, 40)}" does not define. Nothing was checked for it.`,
      at(source.file, `/requiredKeys/${index}`),
      { suggestion: 'Correct the key name, or add it to the source catalog.' },
    ))
  }
  for (const [index, prefix] of required.prefixes.entries()) {
    if (sourceKeys.some((name) => name === prefix || name.startsWith(`${prefix}.`))) continue
    findings.push(makeFinding(
      'required-key-unknown',
      `requiredKeyPrefixes names "${sanitize(prefix)}", which matches no key in the source locale "${sanitize(sourceLocale.id, 40)}". Nothing was checked for it.`,
      at(source.file, `/requiredKeyPrefixes/${index}`),
      { suggestion: 'Correct the prefix, or add the keys it was meant to cover.' },
    ))
  }

  // Per-catalog checks: blank values, keys the source does not define, and
  // interpolation placeholders against the source value.
  for (const locale of locales) {
    const catalog = catalogs.get(locale.key)
    if (catalog === undefined) continue
    const ownKeys = [...catalog.values.keys()].sort(byCodeUnit)
    for (const key of ownKeys) {
      const value = catalog.values.get(key)
      if (!isUsable(value)) {
        findings.push(makeFinding(
          'empty-translation',
          `Key "${sanitize(key)}" is present in locale "${sanitize(locale.id, 40)}" but blank, so it would render as nothing. A blank value is treated as absent for fallback resolution.`,
          at(catalog.file, keyPointer(locale, key)),
          { suggestion: 'Translate the key, or remove it so the fallback is explicit.' },
        ))
        continue
      }
      if (!sourceKeySet.has(key)) {
        findings.push(makeFinding(
          'extra-key',
          `Key "${sanitize(key)}" is in locale "${sanitize(locale.id, 40)}" but not in the source locale "${sanitize(sourceLocale.id, 40)}", so nothing will read it.`,
          at(catalog.file, keyPointer(locale, key)),
          { evidence: excerpt(value), suggestion: 'Remove the key, or add it to the source catalog.' },
        ))
        continue
      }
      if (locale.key === sourceKey) continue

      const expected = placeholdersIn(source.values.get(key))
      const actual = placeholdersIn(value)
      const missing = expected.filter((name) => !actual.includes(name))
      const unexpected = actual.filter((name) => !expected.includes(name))
      if (missing.length > 0) {
        findings.push(makeFinding(
          'placeholder-missing',
          `Key "${sanitize(key)}" in locale "${sanitize(locale.id, 40)}" drops the placeholder(s) ${missing.map((name) => `{${sanitize(name, 40)}}`).join(', ')} that the source text interpolates.`,
          at(catalog.file, keyPointer(locale, key)),
          { evidence: excerpt(value), suggestion: 'Put every source placeholder back into the translation.' },
        ))
      }
      if (unexpected.length > 0) {
        findings.push(makeFinding(
          'placeholder-unexpected',
          `Key "${sanitize(key)}" in locale "${sanitize(locale.id, 40)}" interpolates ${unexpected.map((name) => `{${sanitize(name, 40)}}`).join(', ')}, which the source text does not supply, so it renders literally.`,
          at(catalog.file, keyPointer(locale, key)),
          { evidence: excerpt(value), suggestion: 'Remove the placeholder, or add it to the source text first.' },
        ))
      }
    }
  }

  // Resolution: what each locale actually serves for each source key.
  let checked = 0
  let undetermined = 0
  let audited = 0
  for (const locale of locales) {
    const catalog = catalogs.get(locale.key)
    if (catalog === undefined) continue
    audited += 1
    const order = orders.get(locale.key) ?? [locale.key]
    const truncated = truncatedChains.has(locale.key)
    let localeUndetermined = 0

    for (const key of sourceKeys) {
      checked += 1
      const outcome = resolveKey(key, order, catalogs, truncated)
      const required = isRequired(key)

      if (outcome.state === 'undetermined') {
        localeUndetermined += 1
        undetermined += 1
        continue
      }
      if (outcome.state === 'self') {
        if (
          required
          && locale.key !== sourceKey
          && catalog.values.get(key).trim() === source.values.get(key).trim()
        ) {
          findings.push(makeFinding(
            'untranslated-copy',
            `Required key "${sanitize(key)}" in locale "${sanitize(locale.id, 40)}" is character for character the source text. It may never have been translated.`,
            at(catalog.file, keyPointer(locale, key)),
            { evidence: excerpt(catalog.values.get(key)), suggestion: 'Translate the value, or confirm the term is intentionally identical.' },
          ))
        }
        continue
      }
      if (outcome.state === 'fallback') {
        const from = byKey.get(outcome.at)
        if (required) {
          findings.push(makeFinding(
            'required-key-satisfied-by-fallback',
            `Required key "${sanitize(key)}" has no translation in locale "${sanitize(locale.id, 40)}" and would be served from "${sanitize(from.id, 40)}". Required content must never be filled by a fallback.`,
            at(catalog.file, keyPointer(locale, key)),
            { suggestion: `Add a translation of "${sanitize(key)}" to the ${sanitize(locale.id, 40)} catalog.` },
          ))
        } else {
          findings.push(makeFinding(
            'missing-key',
            `Key "${sanitize(key)}" has no translation in locale "${sanitize(locale.id, 40)}" and resolves to "${sanitize(from.id, 40)}".`,
            at(catalog.file, keyPointer(locale, key)),
            { suggestion: `Translate "${sanitize(key)}" for ${sanitize(locale.id, 40)}, or accept the fallback deliberately.` },
          ))
        }
        continue
      }
      findings.push(makeFinding(
        required ? 'required-key-missing' : 'unresolved-key',
        `Key "${sanitize(key)}" resolves to nothing in locale "${sanitize(locale.id, 40)}": neither it nor any locale in its fallback chain defines a value.`,
        at(catalog.file, keyPointer(locale, key)),
        { suggestion: `Add "${sanitize(key)}" to the ${sanitize(locale.id, 40)} catalog or to a locale it falls back to.` },
      ))
    }

    if (localeUndetermined > 0) {
      findings.push(makeFinding(
        'resolution-not-determined',
        `${localeUndetermined} key(s) in locale "${sanitize(locale.id, 40)}" have no known resolution, because its fallback chain contains a catalog that was not read, an undeclared locale, or an edge past the depth limit.`,
        at(catalog.file, `/locales/${locale.index}/fallback`),
        { suggestion: 'Fix the chain reported above, then run the audit again.' },
      ))
    }
  }

  return { findings, checked, keys: sourceKeys.length, requiredKeys: sourceKeys.filter(isRequired).length, undetermined, audited }
}
