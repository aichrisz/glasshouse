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

---

# v1.1 — MIRROR MATCH

Comparing two previously exported reports, locally. Same discipline as v1.0: one
focused check added to `verify.mjs` first, run to observe a real failure, then the
minimum production code, then the focused check again. Commands and output below
are copied from the terminal, with trailing whitespace stripped so
`git diff --check` stays clean — the verifier's failure lines end with `| `.

Baseline before starting (v1.0, clean `main`):

```
$ node verify.mjs
verify: 24 passed, 0 failed, 24 selected, 24 defined
exit=0
```

---

## Slice 25 — an imported report is bounded, parseable and recognisable

RED

```
$ node verify.mjs --only 'core/import'
FAIL  core/import: rejects unbounded, malformed, non-object and foreign report text: parseReportText must be a function | + actual - expected |  | + 'undefined'

verify: 0 passed, 1 failed, 1 selected, 25 defined (filter: core/import)
exit=1
```

GREEN — added `REPORT_IMPORT_LIMITS` (256 KiB / `262144` bytes), a pure
`utf8ByteLength()` so the bound does not depend on a platform encoder, and
`parseReportText()` gating on: not text, too large (short-circuiting before
`JSON.parse`), empty, malformed JSON, non-object root, foreign `app`, and an
unsupported `reportVersion`.

```
$ node verify.mjs --only 'core/import'
PASS  core/import: rejects unbounded, malformed, non-object and foreign report text

verify: 1 passed, 0 failed, 1 selected, 25 defined (filter: core/import)
exit=0
```

---

## Slice 26 — the signal list must be exactly the catalog, once each

RED

```
$ node verify.mjs --only 'core/import: rejects missing'
FAIL  core/import: rejects missing, duplicated and unknown probe ids: expected rejection for signals-missing |  | true !== false |

verify: 0 passed, 1 failed, 1 selected, 26 defined (filter: core/import: rejects missing)
exit=1
```

GREEN — `validateReport()` now requires a signals array and accumulates
`unknown-probe`, `duplicate-probe` and `missing-probe` for the whole file before
returning, so a reader sees every problem at once rather than one per attempt.

```
$ node verify.mjs --only 'core/import'
PASS  core/import: rejects unbounded, malformed, non-object and foreign report text
PASS  core/import: rejects missing, duplicated and unknown probe ids

verify: 2 passed, 0 failed, 2 selected, 26 defined (filter: core/import)
exit=0
```

---

## Slice 27 — the file's own arithmetic is recomputed, never trusted

RED

```
$ node verify.mjs --only 'core/import: rejects invalid'
FAIL  core/import: rejects invalid grades and score arithmetic it cannot re-derive: expected rejection for invalid-status |  | true !== false |

verify: 0 passed, 1 failed, 1 selected, 27 defined (filter: core/import: rejects invalid)
exit=1
```

While driving this one to green the check itself failed three more times, each
time because the test's assumption about the fixture was wrong rather than
because the code was. Those are recorded because they are the interesting part:

```
FAIL  ... expected rejection for invalid-detail |  | true !== false |
FAIL  ... expected rejection for invalid-points |  | true !== false |
FAIL  ... expected rejection for score-inconsistent |  | true !== false |
```

- `memory` was asserted to be unsupported in fixture A, but A supplies it, so
  "declares a detail grade it cannot carry" was a no-op mutation.
- `memory.points = 5` was already its correct value, so the mutation asserted
  nothing.
- Fixture A scores a full 88/88, so relabelling it "Broad surface" was also a
  no-op. The mutation was changed to mislabel it "Narrow surface".

Fixture A scoring 88/88 turned out to be worth keeping: it makes every delta in
the later slices a reduction, which is the direction a reader actually cares
about.

GREEN — per-signal validation of status against `STATUSES`, detail against the
status (`full`/`coarse` for `ok`, `none` otherwise), weight against the catalog,
and points against `scoreSignal()`. Then the score block: `score-missing`,
`score-bounds` (maximum and range), and finally `category-inconsistent` /
`score-inconsistent` by rebuilding the whole score from the file's own statuses
and details with `scoreSnapshot()` and comparing every figure.

```
$ node verify.mjs --only 'core/import'
PASS  core/import: rejects unbounded, malformed, non-object and foreign report text
PASS  core/import: rejects missing, duplicated and unknown probe ids
PASS  core/import: rejects invalid grades and score arithmetic it cannot re-derive

verify: 3 passed, 0 failed, 3 selected, 27 defined (filter: core/import)
exit=0
```

---

## Slice 28 — a redacted export imports cleanly, re-derived from the catalog

RED

```
$ node verify.mjs --only 'core/import: accepts'
FAIL  core/import: accepts a redacted export and re-derives it from the catalog: a report without raw values is flagged as redacted | + actual - expected |  | + undefined

verify: 0 passed, 1 failed, 1 selected, 28 defined (filter: core/import: accepts)
exit=1
```

GREEN — the accepted form is a closed shape built from `PROBE_CATALOG` and from
the recomputed score, in catalog order, with unrecognised keys dropped. Labels,
categories, weights, caps and bands come from the code, so a file cannot inject
text into the page or relabel itself into a better figure. The test proves this
by renaming a signal's label to `ATTACKER TEXT` and asserting it never appears.

```
$ node verify.mjs --only 'core/import'
PASS  core/import: accepts a redacted export and re-derives it from the catalog

verify: 4 passed, 0 failed, 4 selected, 28 defined (filter: core/import)
exit=0
```

---

## Slice 29 — raw values require a literal boolean and must still be valid

RED

```
$ node verify.mjs --only 'core/import: reads raw'
FAIL  core/import: reads raw values only behind a literal boolean flag: Cannot read properties of null (reading 'userAgent')

verify: 0 passed, 1 failed, 1 selected, 29 defined (filter: core/import: reads raw)
exit=1
```

GREEN — `snapshotVersion` joined the version contract; `includesRawValues` must
be a literal boolean or the file is refused with `raw-flag-invalid`, so the
string `"true"` can never be read as consent. When values are present each one
goes back through `normalizeSignal()`: a value that is unusable, or that grades
differently from the grade the file declares, is `raw-values-invalid`; an `ok`
probe with no value is `raw-values-missing`; a non-`ok` probe carrying a value is
refused rather than quietly ignored. A file that declares redaction but still
contains values is read as redacted, so values a report says it omitted are never
displayed.

```
$ node verify.mjs --only 'core/import'
PASS  core/import: reads raw values only behind a literal boolean flag

verify: 5 passed, 0 failed, 5 selected, 29 defined (filter: core/import)
exit=0
```

---

## Slice 30 — a redacted pair still compares in full

RED

```
$ node verify.mjs --only 'core/mirror'
FAIL  core/mirror: compares two redacted reports structurally: core.compareReports is not a function

verify: 0 passed, 1 failed, 1 selected, 30 defined (filter: core/mirror)
exit=1
```

GREEN — `compareReports(a, b)` returns each side's own headline figures, the
A-to-B total and percentage deltas, per-category deltas that sum to the total
delta, and a per-signal record with status/detail/points changes, an
`increased`/`decreased`/`unchanged` exposure classification, and an ordered
`changes` list. `COMPARISON_SEMANTICS` states in the result what a comparison
does and does not mean. Reversing the arguments reverses the sign.

```
$ node verify.mjs --only 'core/mirror'
PASS  core/mirror: compares two redacted reports structurally

verify: 1 passed, 0 failed, 1 selected, 30 defined (filter: core/mirror)
exit=0
```

---

## Slice 31 — exact values only when both sides carry them

RED

```
$ node verify.mjs --only 'core/mirror: adds exact'
FAIL  core/mirror: adds exact value changes only when both reports carry values: Expected values to be strictly equal: | + actual - expected |  | + 'not-read'

verify: 0 passed, 1 failed, 1 selected, 31 defined (filter: core/mirror: adds exact)
exit=1
```

GREEN — `valueComparison` became `same` / `different` / `not-read` /
`unavailable`, values are carried only when both sides opted in, and `different`
is appended to `changes` after the structural tags. One redacted side sets every
signal to `unavailable` and withdraws the open side's values from the result
entirely, which the test checks by asserting no `Mozilla` survives a mixed pair.

```
$ node verify.mjs --only 'core/mirror'
PASS  core/mirror: compares two redacted reports structurally
PASS  core/mirror: adds exact value changes only when both reports carry values

verify: 2 passed, 0 failed, 2 selected, 31 defined (filter: core/mirror)
exit=0
```

---

## Slice 32 — the saved comparison is redacted by default

RED

```
$ node verify.mjs --only 'core/mirror: the comparison export'
FAIL  core/mirror: the comparison export omits exact values unless opted in: core.buildComparisonExport is not a function

verify: 0 passed, 1 failed, 1 selected, 32 defined (filter: core/mirror: the comparison export)
exit=1
```

The first implementation then tripped an existing gate, which is exactly what it
is for:

```
$ node verify.mjs --only 'core/'
FAIL  core/purity: core.mjs references no browser global, clock or randomness: core.mjs must not reference document

verify: 24 passed, 1 failed, 25 selected, 32 defined (filter: core/)
exit=1
```

The export object had a `document: 'comparison'` key. The purity gate strips
string literals but not property names, and it was right to complain: a bare
`document` in this module is precisely what the gate exists to catch. The key was
renamed to `kind`.

GREEN — `buildComparisonExport()` removes `valueBefore`, `valueAfter`,
`displayBefore` and `displayAfter` from every signal and replaces them with
`valuesOmitted: true` unless the caller passes literal `true` *and* the
comparison actually has exact values. Opting in on a redacted pair yields
`includesExactValues: false` with a note explaining why, rather than an empty
promise. Both sides' save time, redaction state and totals are recorded.

```
$ node verify.mjs --only 'core/'
PASS  core/purity: core.mjs references no browser global, clock or randomness
PASS  core/mirror: the comparison export omits exact values unless opted in

verify: 25 passed, 0 failed, 25 selected, 32 defined (filter: core/)
exit=0
```

---

## Slice 33 — accessible import controls and a live result region

RED

```
$ node verify.mjs --only 'html/mirror'
FAIL  html/mirror: exposes accessible import controls and a live result region: needs a labelled section
exit=1
```

GREEN — a labelled `Mirror Match` section with two real `<input type="file">`
controls, each with a real `<label>` and an `accept`, three real `<button>`
controls, a labelled opt-in checkbox, and its own `role="status"`
`aria-live="polite"` region so an import message never overwrites the scan's.
The page states the 256 KiB bound, which report versions it can read, and the
redacted-versus-raw semantics. Every decision is delegated to `core.mjs`; the
gate also asserts none of the import, comparison or export logic is duplicated in
the page.

```
$ node verify.mjs --only 'html/'
PASS  html/mirror: exposes accessible import controls and a live result region

verify: 6 passed, 0 failed, 6 selected, 33 defined (filter: html/)
exit=0
```

---

## Slice 34 — no persistence, no network, and no stale comparison

This is the slice that checks the strongest claim Mirror Match makes, over a
delimited `/* mirror match: begin … end */` region of `index.html`.

RED — the first version of the gate failed on its own strictness:

```
$ node verify.mjs --only 'html/mirror: keeps'
FAIL  html/mirror: keeps imported reports local, unpersisted and off the network: exactly one place may set the current comparison |  | 2 !== 1 |
exit=1
```

Two assignments to `mirrorState.comparison` were legitimate — one producing it,
one clearing it — so the assertion was tightened to "exactly one place may
*produce* the current comparison" (`= core.compareReports(`).

Writing the gate then exposed a genuine defect: after a successful comparison the
save button stayed enabled, so choosing a different file and pressing save would
have written a comparison describing a pair that was no longer selected. The gate
was extended to require a single invalidation path, which failed for real:

```
$ node verify.mjs --only 'html/mirror: keeps'
FAIL  html/mirror: keeps imported reports local, unpersisted and off the network: the region needs a single invalidation path
exit=1
```

GREEN — added `invalidateMirror()`, wired to the `change` event on both file
inputs, which discards both imports, empties the result region and says so. The
gate now asserts, over the region: no `localStorage`, `sessionStorage`,
`setItem`, `removeItem`, `indexedDB`, `openDatabase`, cookie, cache or file-system
API; no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
`FormData`, `postMessage`, `BroadcastChannel`, `action=` or `src=`; that the size
bound is enforced *before* `.text()` is called; that validation failures are
collected and gated before any state is committed and before anything is
rendered; and that clearing resets both inputs, the in-memory state and the
result region.

```
$ node verify.mjs --only 'html/'
PASS  html/mirror: keeps imported reports local, unpersisted and off the network

verify: 7 passed, 0 failed, 7 selected, 34 defined (filter: html/)
exit=0
```

---

## Slice 35 — the README cannot drift from the validator

RED

```
$ node verify.mjs --only 'readme/mirror'
FAIL  readme/mirror: documents the workflow, bound, schema and honest limits: README needs a "Mirror Match" section
exit=1
```

A second real failure followed, from the anti-drift check itself:

```
FAIL  readme/mirror: documents the workflow, bound, schema and honest limits: expected the validator to emit a real set of codes
exit=1
```

The scan for emitted codes assumed `importError('code'` on one line, but the
calls are wrapped across lines by the formatter. The pattern was corrected to
allow the line break rather than reformatting the code to suit the test.

GREEN — added `REPORT_IMPORT_ERROR_CODES` as published data, and the gate now
asserts it lists *exactly* the codes `importError()` can emit in `core.mjs`, and
that the README documents every one of them plus the two page-level codes
(`no-file`, `unreadable`). It also checks the bound in both its label and its
byte figure, the report and snapshot versions, the four redacted comparison keys,
both output filenames, and that the section makes no claim about two reports
coming from the same device.

```
$ node verify.mjs --only 'readme/'
PASS  readme/docs: documents every probe, weight, cap and boundary truthfully
PASS  readme/mirror: documents the workflow, bound, schema and honest limits

verify: 2 passed, 0 failed, 2 selected, 35 defined (filter: readme/)
exit=0
```

---

## Full suite

```
$ node verify.mjs
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
PASS  core/compare: classifies value, status, added and removed changes
PASS  core/purity: core.mjs references no browser global, clock or randomness
PASS  html/shell: is a self-contained offline document that imports core.mjs
PASS  html/probes: collects every catalog probe and reuses core, never reimplements it
PASS  html/controls: exposes accessible controls, guidance and a local export
PASS  html/reveal: renders each signal during the staged probe loop
PASS  html/syntax: the inline module parses as an ES module
PASS  readme/docs: documents every probe, weight, cap and boundary truthfully
PASS  repo/hygiene: ships only the intended files, with no residue
PASS  core/import: rejects unbounded, malformed, non-object and foreign report text
PASS  core/import: rejects missing, duplicated and unknown probe ids
PASS  core/import: rejects invalid grades and score arithmetic it cannot re-derive
PASS  core/import: accepts a redacted export and re-derives it from the catalog
PASS  core/import: reads raw values only behind a literal boolean flag
PASS  core/mirror: compares two redacted reports structurally
PASS  core/mirror: adds exact value changes only when both reports carry values
PASS  core/mirror: the comparison export omits exact values unless opted in
PASS  html/mirror: exposes accessible import controls and a live result region
PASS  html/mirror: keeps imported reports local, unpersisted and off the network
PASS  readme/mirror: documents the workflow, bound, schema and honest limits

verify: 35 passed, 0 failed, 35 selected, 35 defined
exit=0
```

```
$ node --check core.mjs && node --check verify.mjs && git diff --check
exit=0
```

---

## Artifact check (not a shipped file)

The gates above are structural: they read `index.html` as text. To confirm the
page's own runtime behavior, the inline module was extracted and executed in Node
against a minimal DOM/File shim, and Mirror Match was driven the way a person
would drive it. The harness lived in `/tmp` and was deleted afterwards, so the
repository still ships only its five files.

No browser is installed in this environment, so this stands in for a headless
browser run rather than replacing one. It executes the page's real code, but with
a shimmed DOM, which is the limitation to keep in mind.

```
$ node /tmp/gh-harness.mjs
ok    scan completed and rendered cards
ok    scan status announced a result
ok    a snapshot was stored under the disclosed key
ok    redacted pair produced a comparison
ok    redacted pair states exact values unavailable
ok    redacted pair shows the rendering delta
ok    save button became available
ok    status announced the comparison
ok    nothing was persisted by the import
ok    default comparison filename is the redacted one
ok    default comparison omits values
ok    default comparison is valid JSON
ok    raw pair shows the exact reading change
ok    opted-in comparison filename says so
ok    opted-in comparison contains the values
ok    mixed pair still compares structurally
ok    mixed pair withholds the open side values
ok    opting in cannot conjure values
ok    refusal says nothing was imported
ok    refusal names both problems
ok    refusal shows no comparison
ok    refusal disabled saving
ok    oversized file was refused without being read
ok    oversized refusal names the bound
ok    foreign report refused
ok    hand-edited total refused
ok    clear emptied the result region
ok    clear reset both file inputs
ok    clear disabled saving
ok    clear announced itself
ok    stale comparison discarded on new file choice
ok    stale comparison cannot be saved

artifact: all checks passed
```

The oversized case is worth calling out: the shim's `text()` sets a flag if it is
ever called, and the check asserts the flag is still false — so the page really
does refuse a large file without reading it, rather than reading it and then
complaining.

---

## Independent review slice — strict score-shape validation

Review found that an otherwise valid imported report could omit its score band or
append duplicate/unknown scoring categories. Those fields were ignored and
re-derived safely, but accepting the malformed shape contradicted the documented
strict schema.

RED:

```
$ node verify.mjs --only 'core/import: rejects invalid grades'
FAIL  core/import: rejects invalid grades and score arithmetic it cannot re-derive: expected rejection for score-inconsistent |  | true !== false |

verify: 0 passed, 1 failed, 1 selected, 35 defined (filter: core/import: rejects invalid grades)
```

GREEN — the validator now requires the derived band and each published category
exactly once, with no unknown categories:

```
$ node verify.mjs --only 'core/import: rejects invalid grades'
PASS  core/import: rejects invalid grades and score arithmetic it cannot re-derive

verify: 1 passed, 0 failed, 1 selected, 35 defined (filter: core/import: rejects invalid grades)
```

## Rendered-browser closure

After a temporary Playwright 1.62.1/Chrome-for-Testing installation outside the
repository, the real page was exercised at 1440×1000 desktop and 390×844 mobile
viewports. Both redacted fixtures were selected through the native file inputs;
Mirror Match reported `+19 points`, `3 of 14 signals differ`, exact values
unavailable, and enabled the local comparison export. Clear reset both inputs
and disabled export. Each viewport made only the two expected same-origin
requests (`/` and `/core.mjs`), emitted no console/page errors or failed requests,
and had document width exactly equal to viewport width. Screenshots were also
inspected for clipping, overlap, and broken responsive layout.

## Independent review slice — in-flight import cancellation

Fresh-context review found a privacy race: pressing **Clear imported reports**
while asynchronous `File.text()` reads were pending could let the old run commit
after the clear. File changes during that window could similarly mismatch the
visible file names and the comparison.

RED:

```
$ node verify.mjs --only 'html/mirror: keeps imported'
FAIL  html/mirror: keeps imported reports local, unpersisted and off the network: an asynchronous read must not commit after clear or invalidation cancels its run

verify: 0 passed, 1 failed, 1 selected, 35 defined (filter: html/mirror: keeps imported)
```

GREEN — each run now has a monotonic identifier, clear/change invalidates it,
stale completions return before state mutation, and both file controls are locked
only while reads are in flight and restored in `finally`:

```
$ node verify.mjs --only 'html/mirror: keeps imported'
PASS  html/mirror: keeps imported reports local, unpersisted and off the network

verify: 1 passed, 0 failed, 1 selected, 35 defined (filter: html/mirror: keeps imported)
```

The complete rendered desktop/mobile interaction run remained green after this
fix. A separate deterministic fuzz pass sent 5,000 bounded JSON values through
`parseReportText()` without a throw and confirmed oversized text is rejected.

## Independent review slice — adversarial nesting bounds

A second fresh-context review constructed a report under the 256 KiB file limit
whose version field was nested 5,000 arrays deep. The rejection message attempted
to recursively stringify that untrusted value and overflowed the call stack.

RED:

```
$ node verify.mjs --only 'core/import: rejects unbounded'
FAIL  core/import: rejects unbounded, malformed, non-object and foreign report text: Got unwanted exception: bounded adversarial JSON must fail closed instead of overflowing the rejection path | Actual message: "Maximum call stack size exceeded"

verify: 0 passed, 1 failed, 1 selected, 35 defined (filter: core/import: rejects unbounded)
```

GREEN — rejection messages now describe untrusted values without recursive
serialization. Raw-value normalization also gained an explicit depth bound,
proven with a 20,000-level nested value:

```
$ node verify.mjs --only 'core/import: rejects unbounded'
PASS  core/import: rejects unbounded, malformed, non-object and foreign report text

$ node verify.mjs --only 'core/import: reads raw values'
PASS  core/import: reads raw values only behind a literal boolean flag
```

## Independent review slice — deletion versus in-flight scan

Final review also found a baseline privacy race outside Mirror Match: deleting
local data while the staged probe scan was still running removed the snapshot,
but that same scan later wrote it back.

RED:

```
$ node verify.mjs --only 'html/controls'
FAIL  html/controls: exposes accessible controls, guidance and a local export: storage writes need a cancellation generation

verify: 0 passed, 1 failed, 1 selected, 35 defined (filter: html/controls)
```

GREEN — scans now capture a storage generation, deletion advances it, and a scan
may persist only when its generation is still current:

```
$ node verify.mjs --only 'html/controls'
PASS  html/controls: exposes accessible controls, guidance and a local export

verify: 1 passed, 0 failed, 1 selected, 35 defined (filter: html/controls)
```

A real Chromium run then deleted local data during the initial staged scan,
waited for the scan to finish, and confirmed `glasshouse.snapshot.v1` remained
absent on both desktop and mobile viewports.

## Final review slice — bounded refusals and truthful redaction metadata

The final review found two release blockers: a size-compliant report could contain
tens of thousands of signal entries and amplify them into tens of thousands of
DOM errors, and a redacted comparison export could retain a reason claiming
exact values were shown.

RED:

```
$ node verify.mjs --only 'core/import: rejects missing'
FAIL  core/import: rejects missing, duplicated and unknown probe ids: expected "signals-missing", got "missing-probe,..."

$ node verify.mjs --only 'comparison export omits exact values'
FAIL  core/mirror: the comparison export omits exact values unless opted in: export metadata must describe the redaction
```

GREEN — report validation now rejects any signal-array length other than the
published catalog count before per-entry validation, producing one bounded
error. Comparison exports now generate export-specific exact-value metadata:

```
$ node verify.mjs --only 'core/import: rejects missing'
PASS  core/import: rejects missing, duplicated and unknown probe ids

$ node verify.mjs --only 'comparison export omits exact values'
PASS  core/mirror: the comparison export omits exact values unless opted in
```
