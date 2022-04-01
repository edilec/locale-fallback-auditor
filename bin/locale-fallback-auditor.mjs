#!/usr/bin/env node

import { checkProject, exitCodeFor, formatSummary, renderReport } from '../src/index.mjs'

const HELP = `locale-fallback-auditor

Audit translation catalogs and the fallback graph that joins them. Reports
required content a fallback would silently satisfy, interpolation placeholders
the source and a translation disagree about, and fallback cycles.

Usage:
  locale-fallback-auditor --config FILE [--root DIR] [--require-prefix P]... [--json]

Options:
  --config FILE       Project configuration (required)
  --root DIR          Input root that every declared catalog path resolves
                      against and may not escape, lexically or through a
                      symbolic link. Defaults to the directory holding the
                      config.
  --require-prefix P  Treat every key at or under P as requiring translation,
                      in addition to the config. Repeatable.
  --json              Suppress the human summary on stderr
  -h, --help          Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every locale resolved every key, and no required key came from a fallback
  1  the audit completed and found a policy failure
  2  invalid configuration, or evidence the tool could not read. A catalog that
     could not be read, decoded, parsed or compared is reported incomplete,
     never as a pass. On a configuration error stdout stays empty; on
     unreadable evidence stdout carries an "incomplete" report naming what was
     not read.

This tool never fetches anything. Every catalog it reasons about comes from a
file inside the declared input root.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { config: null, root: null, requirePrefixes: [], json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--require-prefix') options.requirePrefixes.push(takeValue('--require-prefix'))
    else throw new Error(`Unknown option "${argument.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 60)}"`)
  }

  if (options.config === null) throw new Error('--config is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await checkProject({
      config: options.config,
      root: options.root ?? undefined,
      requirePrefixes: options.requirePrefixes,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
