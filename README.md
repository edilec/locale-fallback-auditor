# Locale Fallback Auditor

Audit translation catalogs and the fallback graph that joins them. It reports
the three things a fallback graph quietly gets wrong: content that requires a
real translation but is served from another locale, an interpolation placeholder
that the source text and a translation disagree about, and a fallback cycle.

- **Repository:** [edilec/locale-fallback-auditor](https://github.com/edilec/locale-fallback-auditor)
- **Area:** Content & Publishing
- **License:** MIT

The rule the tool exists for is the first one. A fallback graph is meant to keep
a page from breaking, and it does — which is the problem. `pt-BR` with no terms
of service renders the Portuguese ones, or the English ones, and the page looks
finished. Legal text, product names and regulated copy served in the wrong
language with nothing on the page to say so is the failure this tool is built to
catch, so a key marked as requiring translation is satisfied only by the
locale's own catalog. When a fallback resolves one, that is an error naming both
the key and the locale the text would have come from.

Nothing is fetched. Every catalog comes from a file inside a declared input
root, and a locale whose chain contains a catalog that was not read is reported
as undetermined rather than given a verdict either way.

## Install

Node 22 or newer. No runtime dependencies, no dev dependencies, Node built-ins
only.

```sh
npm install locale-fallback-auditor
```

## Use

```sh
npx locale-fallback-auditor --config examples/clean/locale-fallback.config.json
npx locale-fallback-auditor --config app/locale-fallback.config.json --root app --json
npx locale-fallback-auditor --config app/locale-fallback.config.json --require-prefix legal
```

```
--config FILE       Project configuration (required)
--root DIR          Input root every declared catalog path resolves against and
                    may not escape. Defaults to the directory holding the config.
--require-prefix P  Treat every key at or under P as requiring translation, in
                    addition to the config. Repeatable.
--json              Suppress the human summary on stderr
-h, --help          Show help
```

stdout carries the JSON report and nothing else. stderr carries the human
summary and diagnostics.

| Exit | Meaning |
| ---: | --- |
| `0` | every locale resolved every key, and no required key came from a fallback |
| `1` | the audit completed and found a policy failure |
| `2` | invalid configuration, or evidence the tool could not read |

Exit 2 has two shapes. A configuration error means the run never had a subject,
so **stdout is empty** and the message goes to stderr. Evidence that could not be
read, decoded, parsed or compared means the run had a subject and failed to
learn about it, so stdout carries a report with `"status": "incomplete"` naming
exactly what was not read. A consumer piping stdout must handle both.

## Configuration

```json
{
  "schemaVersion": "1",
  "sourceLocale": "en",
  "locales": [
    { "id": "en",    "catalog": "locales/en.json",    "fallback": [] },
    { "id": "pt",    "catalog": "locales/pt.json",    "fallback": ["en"] },
    { "id": "pt-BR", "catalog": "locales/pt-BR.json", "fallback": ["pt"] }
  ],
  "requiredKeys": ["product.name"],
  "requiredKeyPrefixes": ["legal"],
  "limits": { "maxKeysPerCatalog": 20000 }
}
```

An unknown key anywhere in this document is a configuration error, including an
unknown name inside `limits`: a one-character typo must not raise a bound or
drop a requirement by accident.

A catalog is a JSON object of key to translated string. Nested objects flatten
to dotted keys, so `{"legal": {"terms": "..."}}` is `legal.terms`. A value that
is absent, or present but blank, is not a translation and does not satisfy
anything.

`pt-BR` above resolves `pt-BR`, then `pt`, then `en`. Fallback lists may name
more than one locale and are walked depth first in the order written. Locale
tags are matched case insensitively, because BCP 47 is.

## Report

```json
{
  "schemaVersion": "1",
  "tool": "locale-fallback-auditor",
  "status": "fail",
  "summary": {
    "checked": 15, "errors": 1, "warnings": 0, "info": 0,
    "locales": 3, "audited": 3, "keys": 5, "requiredKeys": 3, "undetermined": 0
  },
  "findings": [
    {
      "ruleId": "required-key-satisfied-by-fallback",
      "severity": "error",
      "message": "Required key \"legal.terms\" has no translation in locale \"pt-BR\" and would be served from \"pt\". Required content must never be filled by a fallback.",
      "location": { "file": "locales/pt-BR.json", "pointer": "/locales/2/keys/legal.terms" },
      "suggestion": "Add a translation of \"legal.terms\" to the pt-BR catalog."
    }
  ]
}
```

Findings sort by `(location.file, location.pointer, ruleId, message)`, each
compared by UTF-16 code unit rather than by collation, so the order does not
change with the ICU data a Node build happens to carry. Two runs over identical
inputs produce byte-identical stdout.

Every untrusted string is sanitised and bounded before it reaches the report or
the summary — keys, locale ids, paths and messages, not only the `evidence`
field. A key holding a newline cannot forge a line in the human summary, and a
key holding a slash cannot forge JSON Pointer structure.

See [`docs/locale-fallback-rules.md`](./docs/locale-fallback-rules.md) for the
full rule catalog, the severity of each rule, which rules mean the evidence was
missing, and every enforced limit.

## Limits and non-goals

**What the tool cannot conclude.**

- **It cannot tell you whether a translation is correct.** It checks that a
  value exists, is not blank, comes from the right locale, and interpolates the
  same placeholders as the source. Whether the Portuguese actually says what the
  English says is outside anything a static check can see.
- **`untranslated-copy` is a heuristic, which is why it is a warning.** A
  product name, a unit, or a brand term is often identical across locales on
  purpose. The tool cannot tell that apart from a copy-paste.
- **It cannot see what your i18n runtime does.** The resolution order it reports
  is the one your config declares. If your framework merges catalogs
  differently, resolves regional tags by truncation, or falls back per-namespace,
  the report describes the declaration and not the runtime. Nothing is executed.
- **Placeholder syntax is one documented shape.** `{name}` is recognised, and so
  is the inner half of a `{{name}}` mustache. `%s`, `%1$s`, `$t(key)`,
  `<0>...</0>` and ICU `plural`, `select` and `selectordinal` bodies are not: a
  catalog using them reports neither a missing nor an unexpected placeholder.
  An ICU complex argument is skipped whole, nested arguments in its branches
  included, because a branch body like `{items}` is identifier shaped and
  reading it as a placeholder would fail a correct translation.
  Only the *sets* of names are compared, never how many times one is repeated.
- **It has no opinion about plurals, gender or context variants.** A catalog
  that stores those as an object under a key flattens into ordinary dotted keys,
  and each is compared as its own string.
- **It reads no format but JSON.** There is no PO, XLIFF, YAML, Fluent or
  properties reader, and none is planned here.
- **It never fetches anything.** There is no translation-management-system
  adapter. A locale whose catalog is not on disk inside the input root is
  reported as unread, and unread is never a pass.
- **A cycle is reported, not resolved.** The walk terminates and tells you the
  loop; it does not guess which edge you meant to remove.
- **`checked: 0` is never a pass.** A run that resolved nothing reports
  `no-keys-checked` and exits 2, because green on no evidence is the failure
  mode this catalog was built against.

**Enforced bounds.** Five configurable limits (`maxCatalogBytes`,
`maxCatalogDepth`, `maxFallbackDepth`, `maxKeysPerCatalog`, `maxLocales`) and two
fixed ones (`MAX_CONFIG_BYTES`, `MAX_PATH_LENGTH`). Exceeding any of them is an
explicit finding or a configuration error, never a silent truncation and never a
pass. The defaults are in the docs.

## Guarantees and the tests that defend them

Every claim above has a test that fails when the code behind it is removed. The
severity table is asserted against the documentation in both directions and
against a third hand-written copy in `test/rules.test.mjs`. The set of rules that
mean *evidence was missing* is asserted rule by rule, including the two that are
only `warning`s and whose membership in that set is the sole reason they cannot
produce a pass. Path confinement is tested from both sides: a symlink escaping
the root must be refused, and a file genuinely inside a root that is itself
reached through a symlink must not be.

```sh
npm run check      # lint, test, run the clean example, and pack
npm test
npm run test:coverage
```

## License

MIT. See [LICENSE](./LICENSE).
