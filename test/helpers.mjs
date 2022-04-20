/** Shared fixture builders. This file defines no tests. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = fileURLToPath(new URL('..', import.meta.url))
export const BIN = fileURLToPath(new URL('../bin/locale-fallback-auditor.mjs', import.meta.url))
export const CONFIG_NAME = 'locale-fallback.config.json'

/** Write a throwaway project under the system temp directory. */
export async function makeProject(files) {
  const root = await mkdtemp(join(tmpdir(), 'locale-fallback-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

export async function removeProject(root) {
  await rm(root, { recursive: true, force: true })
}

export function configJson(body) {
  return `${JSON.stringify({ schemaVersion: '1', ...body }, null, 2)}\n`
}

export function catalogJson(body) {
  return `${JSON.stringify(body, null, 2)}\n`
}

/**
 * A three locale project: en is the source, pt falls back to en, pt-BR falls
 * back to pt. `catalogs` supplies each locale's own keys; anything a locale
 * omits is left to the fallback chain.
 */
export function regionalProject({ catalogs, config = {} } = {}) {
  const files = {
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [
        { id: 'en', catalog: 'locales/en.json', fallback: [] },
        { id: 'pt', catalog: 'locales/pt.json', fallback: ['en'] },
        { id: 'pt-BR', catalog: 'locales/pt-BR.json', fallback: ['pt'] },
      ],
      requiredKeyPrefixes: ['legal'],
      ...config,
    }),
  }
  for (const [id, body] of Object.entries(catalogs)) {
    files[`locales/${id}.json`] = catalogJson(body)
  }
  return files
}

/** The catalogs a healthy regional project has: nothing missing anywhere. */
export function healthyCatalogs() {
  return {
    en: { legal: { terms: 'Accept the terms.' }, checkout: { total: 'Total {amount}' } },
    pt: { legal: { terms: 'Aceite os termos.' }, checkout: { total: 'Total {amount}' } },
    'pt-BR': { legal: { terms: 'Aceite os termos.' }, checkout: { total: 'Total {amount}' } },
  }
}

/** Locale records of the shape `buildGraph` consumes. */
export function localeRecords(pairs) {
  return pairs.map(([id, fallback], index) => ({
    index,
    id,
    key: id.toLowerCase(),
    catalog: `locales/${id}.json`,
    fallback,
  }))
}

export function runCli(args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        cwd: options.cwd ?? REPO,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        // `timeout` kills a child that never returns, so a test can assert the
        // CLI came back at all instead of hanging the suite with it.
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error === null ? 0 : error.code,
          killed: error !== null && error.killed === true,
          stdout,
          stderr,
        })
      },
    )
  })
}

/** The rule ids of a report, in report order. */
export function ruleIdsOf(report) {
  return report.findings.map((finding) => finding.ruleId)
}

/** The (ruleId, file, pointer) triples of a report, in report order. */
export function triples(report) {
  return report.findings.map((finding) => [
    finding.ruleId,
    finding.location.file ?? null,
    finding.location.pointer ?? null,
  ])
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

/**
 * One isolating fixture per rule, with the verdict that fixture must reach.
 *
 * `rules` is the exact rule id list the report carries, `status` and `exit` are
 * the observable outcome. They are written here as literals rather than derived
 * from RULE_SEVERITY, because the point of this table is to fail when the rule
 * catalog is edited: a severity downgrade or a dropped evidence-missing flag
 * changes the status and the exit code of a real run, whatever the catalog, the
 * documentation and a hand-written copy of them happen to agree on.
 *
 * Each fixture isolates its rule: nothing else in it fires, so no second rule
 * can supply the verdict and hide the change. `resolution-not-determined` is
 * the one exception and is marked as such -- every way to make a resolution
 * undetermined also reports the catalog, target or depth limit that caused it,
 * so it can never be the only finding.
 */
export function ruleFixtures() {
  const accept = { legal: { terms: 'Accept the terms.' } }
  const aceite = { legal: { terms: 'Aceite os termos.' } }
  const onlyEn = (body) => ({
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [{ id: 'en', catalog: 'locales/en.json', fallback: [] }],
      requiredKeyPrefixes: ['legal'],
      ...body,
    }),
  })
  const pair = (body, extra = {}) => ({
    [CONFIG_NAME]: configJson({
      sourceLocale: 'en',
      locales: [
        { id: 'en', catalog: 'locales/en.json', fallback: [] },
        { id: 'pt', catalog: 'locales/pt.json', fallback: ['en'] },
      ],
      requiredKeyPrefixes: ['legal'],
      ...body,
    }),
    ...extra,
  })

  return [
    {
      ruleId: 'catalog-depth-exceeded',
      expect: { rules: ['catalog-depth-exceeded'], status: 'incomplete', exit: 2 },
      files: {
        ...onlyEn({ limits: { maxCatalogDepth: 2 } }),
        'locales/en.json': catalogJson({ legal: { terms: 'Accept.' }, deep: { under: { here: 'unread' } } }),
      },
    },
    {
      ruleId: 'catalog-key-limit-exceeded',
      expect: { rules: ['catalog-key-limit-exceeded'], status: 'incomplete', exit: 2 },
      files: {
        ...pair({ limits: { maxKeysPerCatalog: 2 } }),
        'locales/en.json': catalogJson({ legal: { terms: 'Accept.' } }),
        'locales/pt.json': catalogJson({ a: '1', b: '2', c: '3' }),
      },
    },
    {
      ruleId: 'catalog-not-utf8',
      expect: { rules: ['catalog-not-utf8'], status: 'incomplete', exit: 2 },
      files: {
        ...pair(),
        'locales/en.json': catalogJson(accept),
        'locales/pt.json': Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
      },
    },
    {
      ruleId: 'catalog-too-large',
      expect: { rules: ['catalog-too-large'], status: 'incomplete', exit: 2 },
      files: {
        ...pair({ limits: { maxCatalogBytes: 120 } }),
        'locales/en.json': catalogJson({ legal: { terms: 'Accept.' } }),
        'locales/pt.json': catalogJson({ legal: { terms: `Aceite ${'os termos '.repeat(20)}` } }),
      },
    },
    {
      ruleId: 'catalog-unparsable',
      expect: { rules: ['catalog-unparsable'], status: 'incomplete', exit: 2 },
      files: { ...pair(), 'locales/en.json': catalogJson(accept), 'locales/pt.json': '{ not json\n' },
    },
    {
      ruleId: 'catalog-unreadable',
      expect: { rules: ['catalog-unreadable'], status: 'incomplete', exit: 2 },
      files: { ...pair(), 'locales/en.json': catalogJson(accept) },
    },
    {
      ruleId: 'catalog-value-not-string',
      expect: { rules: ['catalog-value-not-string'], status: 'incomplete', exit: 2 },
      files: {
        ...pair(),
        'locales/en.json': catalogJson(accept),
        'locales/pt.json': catalogJson({ ...aceite, version: 3 }),
      },
    },
    {
      ruleId: 'duplicate-flattened-key',
      expect: { rules: ['duplicate-flattened-key'], status: 'incomplete', exit: 2 },
      files: {
        ...pair(),
        'locales/en.json': catalogJson(accept),
        'locales/pt.json': '{"legal.terms": "Aceite os termos.", "legal": {"terms": "Aceite."}}\n',
      },
    },
    {
      ruleId: 'empty-translation',
      expect: { rules: ['empty-translation'], status: 'fail', exit: 1 },
      files: {
        ...pair(),
        'locales/en.json': catalogJson(accept),
        'locales/pt.json': catalogJson({ ...aceite, stray: '   ' }),
      },
    },
    {
      ruleId: 'extra-key',
      expect: { rules: ['extra-key'], status: 'pass', exit: 0 },
      files: {
        ...pair(),
        'locales/en.json': catalogJson(accept),
        'locales/pt.json': catalogJson({ ...aceite, stray: 'Antigo' }),
      },
    },
    {
      ruleId: 'fallback-cycle',
      expect: { rules: ['fallback-cycle'], status: 'fail', exit: 1 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'en',
          locales: [
            { id: 'en', catalog: 'locales/en.json', fallback: [] },
            { id: 'pt', catalog: 'locales/pt.json', fallback: ['pt-BR'] },
            { id: 'pt-BR', catalog: 'locales/pt-BR.json', fallback: ['pt'] },
          ],
          requiredKeyPrefixes: ['legal'],
        }),
        'locales/en.json': catalogJson(accept),
        'locales/pt.json': catalogJson(aceite),
        'locales/pt-BR.json': catalogJson({ legal: { terms: 'Aceite os termos brasileiros.' } }),
      },
    },
    {
      ruleId: 'fallback-depth-exceeded',
      expect: { rules: ['fallback-depth-exceeded'], status: 'incomplete', exit: 2 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'a',
          locales: [
            { id: 'a', catalog: 'locales/a.json', fallback: ['b'] },
            { id: 'b', catalog: 'locales/b.json', fallback: ['c'] },
            { id: 'c', catalog: 'locales/c.json', fallback: [] },
          ],
          requiredKeyPrefixes: ['legal'],
          limits: { maxFallbackDepth: 2 },
        }),
        'locales/a.json': catalogJson({ legal: { terms: 'A.' } }),
        'locales/b.json': catalogJson({ legal: { terms: 'B.' } }),
        'locales/c.json': catalogJson({ legal: { terms: 'C.' } }),
      },
    },
    {
      ruleId: 'fallback-target-unknown',
      expect: { rules: ['fallback-target-unknown'], status: 'incomplete', exit: 2 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'en',
          locales: [
            { id: 'en', catalog: 'locales/en.json', fallback: [] },
            { id: 'fr', catalog: 'locales/fr.json', fallback: ['xx'] },
          ],
          requiredKeyPrefixes: ['legal'],
        }),
        'locales/en.json': catalogJson(accept),
        'locales/fr.json': catalogJson({ legal: { terms: 'Acceptez les conditions.' } }),
      },
    },
    {
      ruleId: 'locale-limit-exceeded',
      expect: { rules: ['locale-limit-exceeded'], status: 'incomplete', exit: 2 },
      files: {
        ...pair({ limits: { maxLocales: 1 } }),
        'locales/en.json': catalogJson(accept),
        'locales/pt.json': catalogJson(aceite),
      },
    },
    {
      ruleId: 'missing-key',
      expect: { rules: ['missing-key'], status: 'pass', exit: 0 },
      files: {
        ...pair(),
        'locales/en.json': catalogJson({ ...accept, checkout: { total: 'Total' } }),
        'locales/pt.json': catalogJson(aceite),
      },
    },
    {
      ruleId: 'no-keys-checked',
      expect: { rules: ['no-keys-checked', 'no-required-keys-declared'], status: 'incomplete', exit: 2 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'en',
          locales: [{ id: 'en', catalog: 'locales/en.json', fallback: [] }],
        }),
        'locales/en.json': catalogJson({}),
      },
    },
    {
      ruleId: 'no-required-keys-declared',
      expect: { rules: ['no-required-keys-declared'], status: 'pass', exit: 0 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'en',
          locales: [{ id: 'en', catalog: 'locales/en.json', fallback: [] }],
        }),
        'locales/en.json': catalogJson(accept),
      },
    },
    {
      ruleId: 'placeholder-missing',
      expect: { rules: ['placeholder-missing'], status: 'fail', exit: 1 },
      files: {
        ...pair({ requiredKeyPrefixes: [], requiredKeys: ['checkout.total'] }),
        'locales/en.json': catalogJson({ checkout: { total: 'Total {amount}' } }),
        'locales/pt.json': catalogJson({ checkout: { total: 'Total a pagar' } }),
      },
    },
    {
      ruleId: 'placeholder-unexpected',
      expect: { rules: ['placeholder-unexpected'], status: 'fail', exit: 1 },
      files: {
        ...pair({ requiredKeyPrefixes: [], requiredKeys: ['checkout.total'] }),
        'locales/en.json': catalogJson({ checkout: { total: 'Total {amount}' } }),
        'locales/pt.json': catalogJson({ checkout: { total: 'Total {amount} ({moeda})' } }),
      },
    },
    {
      ruleId: 'redundant-fallback-edge',
      expect: { rules: ['redundant-fallback-edge'], status: 'pass', exit: 0 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'en',
          locales: [
            { id: 'en', catalog: 'locales/en.json', fallback: [] },
            { id: 'de', catalog: 'locales/de.json', fallback: ['en'] },
            { id: 'de-AT', catalog: 'locales/de-AT.json', fallback: ['de', 'en'] },
          ],
          requiredKeyPrefixes: ['legal'],
        }),
        'locales/en.json': catalogJson(accept),
        'locales/de.json': catalogJson({ legal: { terms: 'Bedingungen annehmen.' } }),
        'locales/de-AT.json': catalogJson({ legal: { terms: 'Bedingungen annehmen, bitte.' } }),
      },
    },
    {
      ruleId: 'required-key-missing',
      expect: { rules: ['required-key-missing'], status: 'fail', exit: 1 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'en',
          locales: [
            { id: 'en', catalog: 'locales/en.json', fallback: [] },
            { id: 'ja', catalog: 'locales/ja.json', fallback: [] },
          ],
          requiredKeyPrefixes: ['legal'],
        }),
        'locales/en.json': catalogJson(accept),
        'locales/ja.json': catalogJson({}),
      },
    },
    {
      ruleId: 'required-key-satisfied-by-fallback',
      expect: { rules: ['required-key-satisfied-by-fallback'], status: 'fail', exit: 1 },
      files: {
        ...pair(),
        'locales/en.json': catalogJson(accept),
        'locales/pt.json': catalogJson({}),
      },
    },
    {
      ruleId: 'required-key-unknown',
      expect: { rules: ['required-key-unknown'], status: 'fail', exit: 1 },
      files: {
        ...onlyEn({ requiredKeyPrefixes: [], requiredKeys: ['legal.typo'] }),
        'locales/en.json': catalogJson(accept),
      },
    },
    {
      ruleId: 'resolution-not-determined',
      // Not isolated, and cannot be: a chain is undetermined only because a
      // catalog, a target or the depth limit was already reported.
      expect: { rules: ['fallback-target-unknown', 'resolution-not-determined'], status: 'incomplete', exit: 2 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'en',
          locales: [
            { id: 'en', catalog: 'locales/en.json', fallback: [] },
            { id: 'fr', catalog: 'locales/fr.json', fallback: ['xx'] },
          ],
          requiredKeyPrefixes: ['legal'],
        }),
        'locales/en.json': catalogJson({ ...accept, checkout: { total: 'Total' } }),
        'locales/fr.json': catalogJson({ legal: { terms: 'Acceptez les conditions.' } }),
      },
    },
    {
      ruleId: 'unresolved-key',
      expect: { rules: ['unresolved-key'], status: 'fail', exit: 1 },
      files: {
        [CONFIG_NAME]: configJson({
          sourceLocale: 'en',
          locales: [
            { id: 'en', catalog: 'locales/en.json', fallback: [] },
            { id: 'ja', catalog: 'locales/ja.json', fallback: [] },
          ],
          requiredKeyPrefixes: ['legal'],
        }),
        'locales/en.json': catalogJson({ ...accept, checkout: { total: 'Total' } }),
        'locales/ja.json': catalogJson({ legal: { terms: 'Riyou kiyaku.' } }),
      },
    },
    {
      ruleId: 'untranslated-copy',
      expect: { rules: ['untranslated-copy'], status: 'pass', exit: 0 },
      files: {
        ...pair(),
        'locales/en.json': catalogJson({ legal: { terms: 'Edilec Ledger' } }),
        'locales/pt.json': catalogJson({ legal: { terms: 'Edilec Ledger' } }),
      },
    },
  ]
}
