# GLASSHOUSE TDD evidence

Strict vertical RED → GREEN, one behavior at a time, for the deterministic
production logic in `core.mjs` (normalization, scoring, report redaction,
snapshot comparison) and for the structural gates over `index.html` /
`README.md`.

Every entry below was produced by running the exact command shown and copying
the real terminal output. Commands are run from the repository root.

## Setup (not a test slice)

Before slice 1, two scaffolds were created so that RED failures are behavioral
rather than resolution/syntax errors:

- `verify.mjs` — dependency-free runner (`--only <text>` focused filter,
  `--list`, pass/fail counts, nonzero exit on failure). It imports `core.mjs`
  as a namespace (`import * as core`) precisely so that a missing export
  surfaces as a failing assertion instead of a module link error.
- `core.mjs` — header comment only, zero logic.

Baseline of the empty scaffold:

```
$ node verify.mjs
verify: 0 passed, 0 failed, 0 selected, 0 defined
exit=0
```

---

## Slice 1 — probe catalog is the auditable source of truth

RED

```
$ node verify.mjs --only 'core/catalog'
FAIL  core/catalog: declares >=10 probes with complete auditable metadata: PROBE_CATALOG must be an array

verify: 0 passed, 1 failed, 1 selected, 1 defined (filter: core/catalog)
exit=1
```

GREEN — added `CATEGORIES` (8 capped categories) and `PROBE_CATALOG`
(14 probes with id/label/category/kind/weight/explanation/mitigation).

```
$ node verify.mjs --only 'core/catalog'
PASS  core/catalog: declares >=10 probes with complete auditable metadata

verify: 1 passed, 0 failed, 1 selected, 1 defined (filter: core/catalog)
exit=0
```

---

## Slice 2 — unknown probe ids are rejected

RED

```
$ node verify.mjs --only 'core/normalize: rejects'
FAIL  core/normalize: rejects an unknown probe id: normalizeSignal must be a function | + actual - expected |  | + 'undefined'

verify: 0 passed, 1 failed, 1 selected, 2 defined (filter: core/normalize: rejects)
exit=1
```

GREEN — added `PROBE_BY_ID`, `getProbe()` and a minimal `normalizeSignal()`
that validates its argument shape and the probe id.

```
$ node verify.mjs --only 'core/normalize: rejects'
PASS  core/normalize: rejects an unknown probe id

verify: 1 passed, 0 failed, 1 selected, 2 defined (filter: core/normalize: rejects)
exit=0
```

---

## Slice 3 — absent observation → explicit `unsupported` state

RED (`signal.status` is `undefined`)

```
$ node verify.mjs --only 'core/normalize: absent'
FAIL  core/normalize: absent value becomes unsupported with no detail: Expected values to be strictly equal: | + actual - expected |  | + undefined

verify: 0 passed, 1 failed, 1 selected, 3 defined (filter: core/normalize: absent)
exit=1
```

GREEN — `normalizeSignal()` now carries catalog metadata onto the record and
returns `status:'unsupported'`, `detail:'none'`, `value:null` and the shared
`UNSUPPORTED_DISPLAY` string when nothing was observed.

```
$ node verify.mjs --only 'core/normalize: absent'
PASS  core/normalize: absent value becomes unsupported with no detail

verify: 1 passed, 0 failed, 1 selected, 3 defined (filter: core/normalize: absent)
exit=0
```

---

## Slice 4 — map probes expose declared keys only, with tidy clamped strings

RED (raw object passed straight through, so key set does not match)

```
$ node verify.mjs --only 'core/normalize: map values'
FAIL  core/normalize: map values keep declared keys only and tidy strings: Expected values to be strictly deep-equal: | + actual - expected |  |   [

verify: 0 passed, 1 failed, 1 selected, 4 defined (filter: core/normalize: map values)
exit=1
```

GREEN — added `LIMITS`, leaf normalizers (`normalizeString`, `normalizeNumber`,
`normalizeScalar`), `normalizeMapValue` restricted to each probe's declared
`keys`, and `describeValue`/`clampDisplay` for the human-readable summary.
Declared `keys` arrays were added to the ten map probes in the catalog.

```
$ node verify.mjs --only 'core/normalize'
PASS  core/normalize: rejects an unknown probe id
PASS  core/normalize: absent value becomes unsupported with no detail
PASS  core/normalize: map values keep declared keys only and tidy strings

verify: 3 passed, 0 failed, 3 selected, 4 defined (filter: core/normalize)
exit=0
```

---

## Slice 5 — list probes: dedupe, keep order, honour a declared per-probe limit

RED (list display used the map-style `,` join; no `limit`/`truncated` yet)

```
$ node verify.mjs --only 'core/normalize: list'
FAIL  core/normalize: list values dedupe, preserve order and honour the probe limit: Expected values to be strictly equal: | + actual - expected |  | + 'en-GB,en,cy'

verify: 0 passed, 1 failed, 1 selected, 5 defined (filter: core/normalize: list)
exit=1
```

GREEN — added `limit` to the two list probes (`languages`: 8, `fonts`: 24),
`normalizeListValue()` with dedupe + order preservation + explicit `truncated`
flag, and a list-specific display join.

```
$ node verify.mjs --only 'core/normalize'
PASS  core/normalize: rejects an unknown probe id
PASS  core/normalize: absent value becomes unsupported with no detail
PASS  core/normalize: map values keep declared keys only and tidy strings
PASS  core/normalize: list values dedupe, preserve order and honour the probe limit

verify: 4 passed, 0 failed, 4 selected, 5 defined (filter: core/normalize)
exit=0
```

---

## Slice 6 — numeric probes clamp and round to a declared range

RED

```
$ node verify.mjs --only 'core/normalize: number'
FAIL  core/normalize: number values clamp and round to the declared range: integers are rounded |  | 8.7 !== 9 |

verify: 0 passed, 1 failed, 1 selected, 6 defined (filter: core/normalize: number)
exit=1
```

GREEN — added `range` declarations (`cores` 1–64 integer, `memory` 0.25–1024 at
two decimals) and `normalizeRangedNumber()`.

```
$ node verify.mjs --only 'core/'
PASS  core/catalog: declares >=10 probes with complete auditable metadata
PASS  core/normalize: rejects an unknown probe id
PASS  core/normalize: absent value becomes unsupported with no detail
PASS  core/normalize: map values keep declared keys only and tidy strings
PASS  core/normalize: list values dedupe, preserve order and honour the probe limit
PASS  core/normalize: number values clamp and round to the declared range

verify: 6 passed, 0 failed, 6 selected, 6 defined (filter: core/)
exit=0
```

---

## Slice 7 — denied / error states keep a reason and drop the value

RED (status was ignored entirely, so a blocked probe still reported `ok`)

```
$ node verify.mjs --only 'core/normalize: denied'
FAIL  core/normalize: denied and error states keep a reason and drop the value: Expected values to be strictly equal: |  | 'ok' !== 'denied' |

verify: 0 passed, 1 failed, 1 selected, 7 defined (filter: core/normalize: denied)
exit=1
```

GREEN — added `STATUSES`, `STATUS_DISPLAY` and a `blocked()` helper;
`normalizeSignal()` now honours an incoming status, degrades unknown statuses to
`error` with a stated reason, and always nulls the value for non-ok outcomes.

```
$ node verify.mjs --only 'core/'
PASS  core/catalog: declares >=10 probes with complete auditable metadata
PASS  core/normalize: rejects an unknown probe id
PASS  core/normalize: absent value becomes unsupported with no detail
PASS  core/normalize: map values keep declared keys only and tidy strings
PASS  core/normalize: list values dedupe, preserve order and honour the probe limit
PASS  core/normalize: number values clamp and round to the declared range
PASS  core/normalize: denied and error states keep a reason and drop the value

verify: 7 passed, 0 failed, 7 selected, 7 defined (filter: core/)
exit=0
```

---

## Slice 8 — masked readings grade as `coarse`, not `full`

RED

```
$ node verify.mjs --only 'core/normalize: masked'
FAIL  core/normalize: masked readings are graded coarse rather than full: a generic/masked renderer is coarse |  | 'full' !== 'coarse' |

verify: 0 passed, 1 failed, 1 selected, 8 defined (filter: core/normalize: masked)
exit=1
```

GREEN — added `MASKED_RENDERER_HINTS` + `isMaskedRenderer()`, `coarse`
predicates on `webgl` / `clientHints` / `canvas`, and detail derivation in
`normalizeSignal()`.

```
$ node verify.mjs --only 'core/'
PASS  core/catalog: declares >=10 probes with complete auditable metadata
PASS  core/normalize: rejects an unknown probe id
PASS  core/normalize: absent value becomes unsupported with no detail
PASS  core/normalize: map values keep declared keys only and tidy strings
PASS  core/normalize: list values dedupe, preserve order and honour the probe limit
PASS  core/normalize: number values clamp and round to the declared range
PASS  core/normalize: denied and error states keep a reason and drop the value
PASS  core/normalize: masked readings are graded coarse rather than full

verify: 8 passed, 0 failed, 8 selected, 8 defined (filter: core/)
exit=0
```

---

## Slice 9 — snapshots are complete and in catalog order

RED

```
$ node verify.mjs --only 'core/snapshot: fills'
FAIL  core/snapshot: fills every probe in catalog order without mutating input: core.normalizeSnapshot is not a function

verify: 0 passed, 1 failed, 1 selected, 9 defined (filter: core/snapshot: fills)
exit=1
```

GREEN — added `SNAPSHOT_VERSION` and `normalizeSnapshot()` (catalog-ordered,
gap-filled, last-write-wins, caller-supplied `createdAt`, no input mutation).

```
$ node verify.mjs --only 'core/snapshot'
PASS  core/snapshot: fills every probe in catalog order without mutating input

verify: 1 passed, 0 failed, 1 selected, 9 defined (filter: core/snapshot)
exit=0
```

---

## Slice 10 — per-signal contribution is a published function of detail × weight

RED

```
$ node verify.mjs --only 'core/score: a signal'
FAIL  core/score: a signal contributes weight for full, half for coarse, zero otherwise: core.scoreSignal is not a function

verify: 0 passed, 1 failed, 1 selected, 10 defined (filter: core/score: a signal)
exit=1
```

GREEN — added `DETAIL_FACTORS` (full 1, coarse 0.5, none 0) and `scoreSignal()`,
which returns an auditable contribution record including a human-readable
`reason`.

```
$ node verify.mjs --only 'core/score'
PASS  core/score: a signal contributes weight for full, half for coarse, zero otherwise

verify: 1 passed, 0 failed, 1 selected, 10 defined (filter: core/score)
exit=0
```

---

## Slice 11 — category caps applied, overflow disclosed

RED

```
$ node verify.mjs --only 'core/score: category'
FAIL  core/score: category totals are capped and the overflow is reported: core.scoreSnapshot is not a function

verify: 0 passed, 1 failed, 1 selected, 11 defined (filter: core/score: category)
exit=1
```

GREEN — added `scoreSnapshot()`: one contribution per catalog probe, grouped
into categories in declaration order, `rawPoints` kept alongside capped `points`
plus a `capped` flag, and `total` as the sum of capped category points.

```
$ node verify.mjs --only 'core/score'
PASS  core/score: a signal contributes weight for full, half for coarse, zero otherwise
PASS  core/score: category totals are capped and the overflow is reported

verify: 2 passed, 0 failed, 2 selected, 11 defined (filter: core/score)
exit=0
```

---

## Slice 12 — bounded percentage plus a named band, computed purely

RED

```
$ node verify.mjs --only 'core/score: reports'
FAIL  core/score: reports a bounded percentage and a named band, purely: maxTotal is the sum of category caps |  | undefined !== 88 |

verify: 0 passed, 1 failed, 1 selected, 12 defined (filter: core/score: reports)
exit=1
```

GREEN — added `SCORE_BANDS` (narrow/moderate/elevated/broad at 0/25/50/75%),
`MAX_TOTAL` (88 = sum of caps), the literal `SCORE_FORMULA` string quoted by the
UI and README, `bandForPercent()`, and the `total`/`maxTotal`/`percent`/`band`/
`formula` envelope on `scoreSnapshot()`.

```
$ node verify.mjs --only 'core/score'
PASS  core/score: a signal contributes weight for full, half for coarse, zero otherwise
PASS  core/score: category totals are capped and the overflow is reported
PASS  core/score: reports a bounded percentage and a named band, purely

verify: 3 passed, 0 failed, 3 selected, 12 defined (filter: core/score)
exit=0
```

---

## Slice 13 — deterministic serialization

RED

```
$ node verify.mjs --only 'core/serialize'
FAIL  core/serialize: stable key ordering makes output byte-identical: core.stableStringify is not a function

verify: 0 passed, 1 failed, 1 selected, 13 defined (filter: core/serialize)
exit=1
```

GREEN — added `stableStringify()` (recursive key sort, drops `undefined` and
functions, non-finite numbers to `null`, optional indent).

```
$ node verify.mjs --only 'core/serialize'
PASS  core/serialize: stable key ordering makes output byte-identical

verify: 1 passed, 0 failed, 1 selected, 13 defined (filter: core/serialize)
exit=0
```

---

## Slice 14 — the export omits raw values by default, deeply

RED

```
$ node verify.mjs --only 'core/report: omits'
FAIL  core/report: omits raw values by default, deeply: core.buildReport is not a function

verify: 0 passed, 1 failed, 1 selected, 14 defined (filter: core/report: omits)
exit=1
```

GREEN — added `REPORT_VERSION`, `STORAGE_KEYS`, `redactReport()` (deletes
`value`, `display` and `reason`, sets `valueOmitted`) and `buildReport()`, which
redacts unless `includeRawValues === true`.

```
$ node verify.mjs --only 'core/report'
PASS  core/report: omits raw values by default, deeply

verify: 1 passed, 0 failed, 1 selected, 14 defined (filter: core/report)
exit=0
```

---

## Slice 15 — explicit opt-in for raw values

First attempt produced **no RED**: every assertion was already satisfied by the
slice 14 implementation, so the test drove no new behavior. Recorded rather than
hidden.

```
$ node verify.mjs --only 'core/report: includes'
PASS  core/report: includes raw values only on explicit opt-in

verify: 1 passed, 0 failed, 1 selected, 15 defined (filter: core/report: includes)
exit=0
```

The slice was then extended with a genuinely unimplemented behavior: a redacted
report must *state* that values were withheld on purpose, so a recipient of the
JSON cannot mistake the omission for a bug.

RED

```
$ node verify.mjs --only 'core/report: includes'
FAIL  core/report: includes raw values only on explicit opt-in: a redacted report explains the omission | + actual - expected |  | + 'undefined'

verify: 0 passed, 1 failed, 1 selected, 15 defined (filter: core/report: includes)
exit=1
```

GREEN — added `REDACTED_KEYS` and a `redaction` disclosure block on both report
paths (`applied`, `removedKeys`, `note`).

```
$ node verify.mjs --only 'core/'
PASS  core/catalog: declares >=10 probes with complete auditable metadata
PASS  core/normalize: rejects an unknown probe id
PASS  core/normalize: absent value becomes unsupported with no detail
PASS  core/normalize: map values keep declared keys only and tidy strings
PASS  core/normalize: list values dedupe, preserve order and honour the probe limit
PASS  core/normalize: number values clamp and round to the declared range
PASS  core/normalize: denied and error states keep a reason and drop the value
PASS  core/normalize: masked readings are graded coarse rather than full
PASS  core/snapshot: fills every probe in catalog order without mutating input
PASS  core/score: a signal contributes weight for full, half for coarse, zero otherwise
PASS  core/score: category totals are capped and the overflow is reported
PASS  core/score: reports a bounded percentage and a named band, purely
PASS  core/serialize: stable key ordering makes output byte-identical
PASS  core/report: omits raw values by default, deeply
PASS  core/report: includes raw values only on explicit opt-in

verify: 15 passed, 0 failed, 15 selected, 15 defined (filter: core/)
exit=0
```

---

## Slice 16 — previous-vs-current comparison

RED

```
$ node verify.mjs --only 'core/compare'
FAIL  core/compare: classifies value, status, added and removed changes: core.compareSnapshots is not a function

verify: 0 passed, 1 failed, 1 selected, 16 defined (filter: core/compare)
exit=1
```

Intermediate RED (first implementation collapsed every ok → not-ok transition
into `disappeared`, losing the distinction between an active refusal and a
signal that is simply no longer exposed)

```
$ node verify.mjs --only 'core/compare'
FAIL  core/compare: classifies value, status, added and removed changes: ok -> denied is a status change | + actual - expected |  | + 'disappeared'

verify: 0 passed, 1 failed, 1 selected, 16 defined (filter: core/compare)
exit=1
```

GREEN — added `compareSnapshots()` with catalog-ordered
`value`/`status`/`appeared`/`disappeared` classification, a `stable` list,
display-string-only before/after (never raw values), and `null` when there is no
previous snapshot.

```
$ node verify.mjs --only 'core/compare'
PASS  core/compare: classifies value, status, added and removed changes

verify: 1 passed, 0 failed, 1 selected, 16 defined (filter: core/compare)
exit=0
```

---

## Slice 17 — `core.mjs` stays a pure data module

This slice is a guard rather than new behavior: it locks in acceptance
criterion 9 (no browser/global dependency) so it cannot regress.

First run failed on the harness, not on the code (`readFile` was not yet
imported into `verify.mjs`). That is a setup failure, so it is recorded as such
and the import was added before a real run:

```
$ node verify.mjs --only 'core/purity'
FAIL  core/purity: core.mjs references no browser global, clock or randomness: readFile is not defined
```

RED (real, and a true positive against the *test*, not the module: the naive
substring scan matched the word "window" inside probe explanation prose)

```
$ node verify.mjs --only 'core/purity'
FAIL  core/purity: core.mjs references no browser global, clock or randomness: core.mjs must not reference window

verify: 0 passed, 1 failed, 1 selected, 17 defined (filter: core/purity)
exit=1
```

GREEN — the scan now strips comments and string literals before searching, so it
tests code rather than copy. `core.mjs` itself needed no change: it already
references no browser global, no clock, no randomness and has no imports.

```
$ node verify.mjs --only 'core/purity'
PASS  core/purity: core.mjs references no browser global, clock or randomness

verify: 1 passed, 0 failed, 1 selected, 17 defined (filter: core/purity)
exit=0
```

---

## Slice 18 — document shell: self-contained, offline, mobile-first

RED

```
$ node verify.mjs --only 'html/shell'
FAIL  html/shell: is a self-contained offline document that imports core.mjs: ENOENT: no such file or directory, open '/root/projects/glasshouse/index.html'

verify: 0 passed, 1 failed, 1 selected, 18 defined (filter: html/shell)
exit=1
```

GREEN — created `index.html`: doctype/lang/title/viewport/color-scheme/description
metadata, near-black glass token system, original CSS refraction layers, a
`<canvas>` backdrop whose animation is skipped for `prefers-reduced-motion`, and
an inline `<script type="module">` importing `./core.mjs`. No external URL,
stylesheet, script, media or networking API anywhere in the document.

```
$ node verify.mjs --only 'html/shell'
PASS  html/shell: is a self-contained offline document that imports core.mjs

verify: 1 passed, 0 failed, 1 selected, 18 defined (filter: html/shell)
exit=0
```

---

## Slice 19 — every probe is collected, and the page reuses core rather than copying it

RED

```
$ node verify.mjs --only 'html/probes'
FAIL  html/probes: collects every catalog probe and reuses core, never reimplements it: page needs a collector for probe "screen"

verify: 0 passed, 1 failed, 1 selected, 19 defined (filter: html/probes)
exit=1
```

GREEN — added the report markup (inspection / exposure surface / signals /
comparison sections) and, in the inline module, a collector per catalog probe, a
`digestString()` FNV-1a helper, a bounded 25-name font candidate list, the
staged `runProbes()` runner, and rendering for signals, score and comparison.
All arithmetic is delegated to `core.normalizeSnapshot`, `core.scoreSnapshot`
and `core.compareSnapshots`.

One intermediate failure was a true positive against the page text rather than
the code — an explanatory comment named the high-entropy client-hint API, which
the invasive-API scan flags by design:

```
FAIL  html/probes: collects every catalog probe and reuses core, never reimplements it: page must not use getHighEntropyValues
```

The comment was reworded rather than the scan weakened.

```
$ node verify.mjs --only 'html/'
PASS  html/shell: is a self-contained offline document that imports core.mjs
PASS  html/probes: collects every catalog probe and reuses core, never reimplements it

verify: 2 passed, 0 failed, 2 selected, 19 defined (filter: html/)
exit=0
```

---

## Slice 20 — accessible controls, per-signal guidance, redaction-aware export

RED

```
$ node verify.mjs --only 'html/controls'
FAIL  html/controls: exposes accessible controls, guidance and a local export: missing control #rerun

verify: 0 passed, 1 failed, 1 selected, 20 defined (filter: html/controls)
exit=1
```

GREEN — added a `<progress>` element, a `role="status" aria-live="polite"`
region, three real `<button>` controls (run again / save JSON report / delete
local data), a labelled `include-raw` checkbox persisted in
`glasshouse.settings.v1`, a `<details>` disclosure per signal carrying the
catalog explanation and mitigation, a `<dl>` disclosing both stored keys, a
limitations section, and `exportReport()` / `resetLocalData()`. The export runs
through `core.buildReport()` + `core.stableStringify(report, 2)` and downloads
via a local blob URL.

```
$ node verify.mjs --only 'html/'
PASS  html/shell: is a self-contained offline document that imports core.mjs
PASS  html/probes: collects every catalog probe and reuses core, never reimplements it
PASS  html/controls: exposes accessible controls, guidance and a local export

verify: 3 passed, 0 failed, 3 selected, 20 defined (filter: html/)
exit=0
```

---

## Slice 21 — the inline module is parsed, not trusted

This is a verification gate rather than production behavior, so it passed on
first run:

```
$ node verify.mjs --only 'html/syntax'
PASS  html/syntax: the inline module parses as an ES module

verify: 1 passed, 0 failed, 1 selected, 21 defined (filter: html/syntax)
exit=0
```

A gate that has never failed proves nothing, so it was mutation-checked:
`startBackdrop();` was temporarily changed to `startBackdrop(;` in the inline
module. (The interpreter path in the output below is elided as `<node>`; it was an
absolute host path, deliberately not recorded in the repository.)

```
$ node verify.mjs --only 'html/syntax'
FAIL  html/syntax: the inline module parses as an ES module: Command failed: <node> --check /tmp/glasshouse-inline-27253.mjs | /tmp/glasshouse-inline-27253.mjs:91 |       startBackdrop(; |                     ^

verify: 0 passed, 1 failed, 1 selected, 21 defined (filter: html/syntax)
exit=1
```

The mutation was reverted and the gate passes again. The extracted module is
written to the OS temp directory and removed afterwards; nothing is left in the
repository.

```
$ node verify.mjs --only 'html/syntax'
PASS  html/syntax: the inline module parses as an ES module

verify: 1 passed, 0 failed, 1 selected, 21 defined (filter: html/syntax)
exit=0
```

---

## Slice 22 — README documents what actually ships

RED

```
$ node verify.mjs --only 'readme/'
FAIL  readme/docs: documents every probe, weight, cap and boundary truthfully: ENOENT: no such file or directory, open '/root/projects/glasshouse/README.md'

verify: 0 passed, 1 failed, 1 selected, 22 defined (filter: readme/)
exit=1
```

GREEN — wrote `README.md` covering threat model, limitations, the full probe
table with real weights, probe outcomes and the three published coarse rules,
the score formula with per-category caps, controls, privacy boundary, stored
keys, report/redaction behavior, local preview and verification. The gate
derives its expectations from `PROBE_CATALOG`, `CATEGORIES`, `MAX_TOTAL`,
`SCORE_BANDS` and `STORAGE_KEYS`, so the documentation cannot drift from the
code, and it rejects overclaiming language ("bits of entropy", "guarantee",
"100% private", and similar).

```
$ node verify.mjs --only 'readme/'
PASS  readme/docs: documents every probe, weight, cap and boundary truthfully

verify: 1 passed, 0 failed, 1 selected, 22 defined (filter: readme/)
exit=0
```

Writing the README surfaced a real inconsistency: the `fonts` probe declared a
list limit of 24 while the page tests 25 candidates, so a machine with every
candidate installed would have had its result silently truncated. The limit was
corrected to 25 to match the candidate list documented in the README.

---

## Slice 23 — repository hygiene sweep

First run failed on the harness again (`readdir` not imported); the import was
added, then a real run:

RED — the gate correctly flagged `HANDOFF.md`, which is build instruction rather
than a shipped artifact:

```
$ node verify.mjs --only 'repo/hygiene'
FAIL  repo/hygiene: ships only the intended files, with no residue: Expected values to be strictly deep-equal: | + actual - expected |  |   [

verify: 0 passed, 1 failed, 1 selected, 23 defined (filter: repo/hygiene)
exit=1
```

The actual/expected difference was the extra `HANDOFF.md` entry against the
intended file list `['README.md', 'TDD_EVIDENCE.md', 'core.mjs', 'index.html',
'verify.mjs']`.

GREEN — `HANDOFF.md` was removed, and the tracker scan was narrowed from bare
words to usage shapes (`gtag(`, `dataLayer`, `analytics.`, `Sentry.`, `ga(`,
`_paq`, …) after it correctly-but-unhelpfully flagged the page's own privacy copy
("no analytics"). The copy was kept; the gate was made precise.

```
$ node verify.mjs --only 'repo/hygiene'
PASS  repo/hygiene: ships only the intended files, with no residue

verify: 1 passed, 0 failed, 1 selected, 23 defined (filter: repo/hygiene)
exit=0
```

The sweep now asserts, over `index.html` and `core.mjs`: no absolute URL, no
absolute host path, no `console.*`, no `debugger`, no TODO/FIXME/XXX, no
secret-shaped strings, no tracker usage — and that every `setItem()` call in the
page targets a key from `core.STORAGE_KEYS`, so the page cannot write storage it
has not disclosed.

---

## Slice 24 — each probe is revealed while the staged scan is running

Hermes' post-worker acceptance review found that the status text advanced one
probe at a time, but signal cards were appended only after the entire scan. That
did not satisfy the requested one-by-one reveal.

RED

```
$ node verify.mjs --only 'html/reveal'
FAIL  html/reveal: renders each signal during the staged probe loop: a card must appear before the completed snapshot is finalized

verify: 0 passed, 1 failed, 1 selected, 24 defined (filter: html/reveal)
exit=1
```

GREEN — normalise and render each just-collected signal inside the probe loop,
then finalise the complete snapshot and score without appending a second copy.

```
$ node verify.mjs --only 'html/reveal'
PASS  html/reveal: renders each signal during the staged probe loop

verify: 1 passed, 0 failed, 1 selected, 24 defined (filter: html/reveal)
exit=0
```
