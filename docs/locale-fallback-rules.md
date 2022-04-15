# Rule catalog, limits and boundaries

Every rule id below is stable across releases. Renaming one is a breaking change
and is recorded in the changelog.

## Severity decides the exit code

Severity is declared once, in `RULE_SEVERITY` in `src/rules.mjs`, and every
finding takes its severity from that table. A finding built with an unknown rule
id throws. The table in this document is asserted against the code in both
directions by `test/rules.test.mjs`.

That cross-check alone is not the defence, because editing this file and the
code together satisfies it. `test/rules.test.mjs` therefore carries a third,
hand-written copy of the catalog and asserts the status and exit code each rule
produces on its own, and `test/audit.test.mjs` carries one fixture per rule and
asserts the verdict that fixture reaches. A downgrade has to get past all three.

- any `error` finding, and no missing evidence, means **fail** and exit 1
- `warning` and `info` findings alone mean **pass** and exit 0
- any rule marked *evidence missing* means **incomplete** and exit 2, whatever
  its own severity is

That last row is the one that carries weight. `catalog-value-not-string` and
`resolution-not-determined` are only `warning`s, and neither can produce a pass:
in both cases the tool did not obtain the evidence, so it has nothing to pass
on. Report status is computed from the findings themselves rather than from a
separate flag, so there is no single assignment whose removal would turn an
unread catalog into a green build — and `test/rules.test.mjs` asserts exactly
that for every warning-severity rule in the list.

## Rules

| Rule | Severity | Evidence missing | What it reports |
| --- | --- | --- | --- |
| `catalog-depth-exceeded` | error | yes | A catalog nests objects deeper than `maxCatalogDepth`. The keys under that point were not read. |
| `catalog-key-limit-exceeded` | error | yes | A catalog holds more keys than `maxKeysPerCatalog`. None of them were audited. |
| `catalog-not-utf8` | error | yes | A catalog file could not be decoded as UTF-8. |
| `catalog-too-large` | error | yes | A catalog file is larger than `maxCatalogBytes`. |
| `catalog-unparsable` | error | yes | A catalog file is not valid JSON, or is not a JSON object at the top level. |
| `catalog-unreadable` | error | yes | A catalog file could not be read. |
| `catalog-value-not-string` | warning | yes | A catalog holds a number, boolean, null or array where a translation belongs. The auditor compares strings, so that key was not audited. |
| `duplicate-flattened-key` | error | yes | Two source paths in one catalog flatten to the same key, so which value a loader serves is unknown. The first was kept. |
| `empty-translation` | error | no | A key is present but blank. It renders as nothing, and it is treated as absent for fallback resolution. |
| `extra-key` | warning | no | A locale defines a key the source locale does not, so nothing will read it. |
| `fallback-cycle` | error | no | The fallback graph contains a cycle. Resolution terminates at the repeat, so the locales in the cycle can never reach anything beyond it. |
| `fallback-depth-exceeded` | error | yes | Resolving a locale reached further than `maxFallbackDepth`. The rest of that chain was not followed. |
| `fallback-target-unknown` | error | yes | A locale falls back to a locale the config does not declare. What it would serve is unknown. |
| `locale-limit-exceeded` | error | yes | The config declares more locales than `maxLocales`. Nothing was read. |
| `missing-key` | warning | no | A key that does not require translation has no value in a locale and resolves through the fallback chain. The locale it resolves to is named. |
| `no-keys-checked` | error | yes | No key was resolved in any locale, so there is no evidence to pass or fail on. |
| `no-required-keys-declared` | warning | no | Neither `requiredKeys` nor `requiredKeyPrefixes` names anything, so the check that a fallback never satisfies required content had no subject. |
| `placeholder-missing` | error | no | A translation drops an interpolation placeholder the source text supplies, so the value is rendered with a hole in it. |
| `placeholder-unexpected` | error | no | A translation interpolates a placeholder the source text does not supply, so it renders literally. |
| `redundant-fallback-edge` | info | no | A locale lists a fallback that an earlier entry already reaches. The edge changes nothing. |
| `required-key-missing` | error | no | A key requiring translation resolves to nothing: neither the locale nor any locale in its chain defines a value. |
| `required-key-satisfied-by-fallback` | error | no | A key requiring translation has no value in a locale and would be served from another one. The key and that locale are both named. |
| `required-key-unknown` | error | no | `requiredKeys` names a key, or `requiredKeyPrefixes` names a prefix, that matches nothing in the source locale. Nothing was checked for it. |
| `resolution-not-determined` | warning | yes | A locale's fallback chain contains a catalog that was not read, an undeclared locale, or an edge past the depth limit, so some of its keys have no known resolution. |
| `unresolved-key` | error | no | A key that does not require translation resolves to nothing anywhere in the chain. |
| `untranslated-copy` | warning | no | A key requiring translation holds character-for-character the source text. A term may be intentionally identical, which is why this is a warning. |

`no-keys-checked` is the guard against a vacuous pass: a run that resolved
nothing is `incomplete`, never `pass` with `checked: 0`. It is emitted only when
no other evidence-missing finding already explains the absence, so an unreadable
catalog is reported once rather than twice.

## Configurable limits

Each limit is a positive integer in `config.limits`. An unknown limit name is a
configuration error, not a silently ignored key: a one-character typo must not
raise a bound by accident. Exceeding a limit produces the finding named below
and marks the run incomplete; it never truncates silently.

| Limit | Default | Exceeding it reports |
| --- | ---: | --- |
| `maxCatalogBytes` | 4000000 | `catalog-too-large` |
| `maxCatalogDepth` | 12 | `catalog-depth-exceeded` |
| `maxFallbackDepth` | 16 | `fallback-depth-exceeded` |
| `maxKeysPerCatalog` | 20000 | `catalog-key-limit-exceeded` |
| `maxLocales` | 200 | `locale-limit-exceeded` |

Two further bounds are fixed rather than configurable, and are enforced as
configuration errors because the run cannot start without a usable config:

| Bound | Value | Effect |
| --- | ---: | --- |
| `MAX_CONFIG_BYTES` | 1000000 | A larger config file is refused before it is parsed. |
| `MAX_PATH_LENGTH` | 200 | A longer `locales[].catalog` path is refused before it is opened, so no path in the report needs truncating. |

A locale id must be 1 to 35 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9_-]*`. Validating ids at the door is why a locale id in a JSON Pointer cannot carry a newline; the
translation keys, which cannot be constrained that way, are sanitised on the way
out instead.

## How resolution works

Each locale declares an ordered `fallback` list. Resolution is a depth-first
pre-order walk of that list starting at the locale itself, so

```json
{ "id": "pt-BR", "fallback": ["pt"] }
{ "id": "pt",    "fallback": ["en"] }
{ "id": "en",    "fallback": [] }
```

resolves `pt-BR`, then `pt`, then `en`, and the first locale in that order with
a usable value wins. A value that is absent, or present but blank, is not usable.

Locale tags are matched case insensitively, because BCP 47 is case insensitive.
Declaring both `pt-BR` and `pt-br` is a configuration error rather than two
locales.

The walk carries a visited set, so it terminates on any graph including a cyclic
one, and a path set, so a back edge is reported as `fallback-cycle` rather than
passed over in silence. A cycle does not make resolution unknown — everything
reachable is still visited in a defined order — so it is a failure of the
configuration, not missing evidence. What it does mean is that the locales in
the cycle can never reach anything beyond it, which usually shows up alongside
as `unresolved-key`.

## Interpolation

A placeholder is `{name}`, where the name is letters, digits, underscore, dot or
hyphen. This is the ICU simple-argument shape, and it is also the inner half of
a `{{name}}` mustache, so both are recognised.

Nothing else is. `%s` and `%1$s`, `$t(key)`, `<0>...</0>`, and ICU `plural`,
`select` and `selectordinal` bodies are out of scope: their arguments are not
extracted, and a catalog that uses them will report neither a missing nor an
unexpected placeholder. The comparison is between the *sets* of names in the
source value and in the translation. How many times a name is repeated is not
compared.

## Boundaries

- Nothing is fetched. Every catalog comes from a file the config named, inside a
  declared input root.
- A configured path is resolved and then confined again after every symbolic
  link on it has been followed, against the *real* path of the root. A link that
  leaves the root is refused and nothing is read through it; a file genuinely
  inside a root that is itself reached through a link is not refused.
- Read-only. Nothing is written, and there is no auto-fix.
- Catalog content is data. A translation value never changes what the tool does,
  and every untrusted string is sanitised and bounded before it reaches the
  report or the human summary.

## What the exit codes mean

| Exit | stdout | Meaning |
| ---: | --- | --- |
| `0` | the report, `"status": "pass"` | every locale resolved every key, and no required key came from a fallback |
| `1` | the report, `"status": "fail"` | the audit completed and found a policy failure |
| `2` | **empty** | invalid configuration: the run never had a subject |
| `2` | the report, `"status": "incomplete"` | evidence the tool could not read, decode, parse or compare |
