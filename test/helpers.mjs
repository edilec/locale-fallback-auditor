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
