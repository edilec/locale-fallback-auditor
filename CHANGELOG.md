# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Fallback graph resolution: an ordered, depth-first, pre-order walk per locale,
  carrying a visited set so the walk terminates on any graph and a path set so a
  back edge is reported as `fallback-cycle` rather than passed over. One cycle is
  reported once however many locales can reach it.
- The rule this tool exists for: a key marked as requiring translation is
  satisfied only by the locale's own catalog, and a fallback that resolves one is
  an error naming both the key and the locale the text would have come from.
- Interpolation checks in both directions: a `{name}` the source supplies and the
  translation drops, and a `{name}` the translation invents.
- Catalog flattening of nested objects to dotted keys, with an enforced nesting
  depth limit, an enforced key limit, and a report when two source paths reach
  one key rather than a silent pick.
- `resolution-not-determined`, so that a locale whose chain contains an unread
  catalog, an undeclared target or an edge past the depth limit reports its
  affected keys as undetermined instead of claiming they are missing.
- A frozen `ruleId -> severity` catalog of 26 rules, asserted against
  `docs/locale-fallback-rules.md` in both directions and against a third
  hand-written copy in `test/rules.test.mjs`, and pinned by what each rule does:
  `test/severity.test.mjs` runs one isolating fixture per rule through the
  library and the CLI and asserts the findings, the status and the exit code.
- Five configurable limits and two fixed bounds, each enforced and each
  reporting a named finding or a configuration error rather than truncating.
- `locale-fallback-auditor` CLI with `--config`, `--root`, `--require-prefix`,
  `--json` and `--help`, emitting the v1 report envelope on stdout.
- Clean and deliberately broken example projects under `examples/`.

### Fixed

- ICU `plural`, `select` and `selectordinal` arguments are read as out of scope,
  as the documentation always said they were. An ICU branch body is identifier
  shaped -- `{He}`, `{items}` -- so the `{name}` pattern matched every branch,
  and a correctly translated `select` reported both a missing and an unexpected
  placeholder and failed the run. A complex argument is now recognised by its
  header and skipped whole; a simple argument outside one is still compared.
- A parse failure no longer quotes the document it failed on. V8 writes
  `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, and both
  parse sites interpolated it: `catalog-unparsable` put it in the report on
  stdout and the config loader put it on stderr, so a catalog or a config short
  enough to be nothing but a credential was reproduced in full. `sanitize` never
  helped, since it cuts from the end and the quoted span is at the front. Both
  diagnostics now carry the position, line, column and offending token and never
  the text at them, and `test/parse-failure-redaction.test.mjs` drives the AWS
  documentation placeholder through the real binary and asserts it absent from
  stdout, from stderr and from every prefix down to eight characters.

### Notes

- `0.1.0` is the version recorded in `package.json`. No release has been
  published.
