# GLASSHOUSE

A zero-install, single-page browser inspection. It asks your browser the same
questions a tracking script would ask, shows you each answer as it arrives,
explains what the answer reveals and what you can do about it, and then stops.
It can also compare two reports you saved earlier, so you can see whether a
setting you changed actually changed anything, and repeat the same probes a few
times in a row to see which answers hold still.

Nothing is uploaded. There is no build step, no dependency, no package manager,
no service worker and no network request after the document has loaded. Open
`index.html` and it works — including with the network switched off.

Expected deployment: <https://aichrisz.github.io/glasshouse/>

- `index.html` — the entire interface: original CSS, a canvas backdrop, and one
  inline ES module that collects the probes and renders the results.
- `core.mjs` — every deterministic decision: normalization, scoring, report
  redaction, snapshot comparison, report import/comparison and echo
  classification. Pure functions, no browser globals.
- `verify.mjs` — the test suite and the structural gates. Node built-ins only.
- `TDD_EVIDENCE.md` — the RED/GREEN log for how this was built.

## Threat model

GLASSHOUSE is written for one specific reader: someone who wants to understand
device fingerprinting well enough to make their own decisions about it.

**What it models.** A page you visit runs JavaScript. Without asking you for any
permission, that script can read a set of device and preference signals, combine
them, and use the combination to recognise the same browser again later — even
with cookies cleared. GLASSHOUSE performs exactly that read, locally, and shows
you the result instead of keeping it.

**What is in scope.** Signals readable from an ordinary page in an ordinary tab,
with no permission prompt: display geometry, locale and time zone, platform
strings, low-entropy client hints, input capability, coarse hardware hints,
rendering surfaces (canvas, WebGL, font availability), accessibility and
appearance preferences, and whether client-side storage is usable.

**What is out of scope.** Your IP address and anything else your network layer
reveals; anything requiring a permission (location, camera, microphone,
clipboard); anything the operating system knows but the browser does not expose;
server-side correlation; and anything you type into any page. A page-local
inspection cannot see these, so GLASSHOUSE does not pretend to.

**Adversary assumed.** A script that wants to re-recognise your browser across
visits, quietly, at zero cost. Not a targeted attacker with access to your
device.

**Trust required to use this.** You have to trust that this page does what it
says. That is why there are no dependencies, no minification and no external
resources: the whole thing is auditable in two readable files, and
`node verify.mjs` mechanically checks that no networking API or external URL
appears in either of them.

## Limitations

Read this section before you read your score.

- **It is not an identity check.** GLASSHOUSE never tells you how unique or how
  identifiable you are. Doing that honestly needs a population to compare
  against, and this page has none: it never sees another visitor.
- **The score measures breadth, not risk.** It answers "how much of this fixed
  probe set could be read, and in how much detail" — nothing more. It is not an
  entropy estimate, not a probability, not a fingerprint, and not a security
  verdict.
- **A low score is not privacy.** It means these particular probes returned
  little. Your network, your account logins and your behaviour are all untouched
  by this measurement.
- **Randomisation reads as instability.** Some browsers deliberately return
  noisy or coarsened answers, especially for canvas and WebGL. In the
  "Since your last run" panel, and in an [Echo Test](#echo-test), that appears as
  values that keep changing. That is a protection working, not a fault.
- **The probe set is fixed and small.** A real tracking script can use more
  signals, and more invasive ones. A perfect score here does not mean nothing
  else is readable.
- **Font detection is a sample, not an inventory.** It tests 25 named candidates
  by measuring text width. It cannot enumerate your installed fonts.
- **Browsers differ.** Any probe may report `Not exposed by this browser`,
  `Blocked by browser or user settings`, or `Could not be read`. Those are
  first-class outcomes here, not errors to be worked around.
## Probes

14 probes, grouped into eight scoring categories. Every probe is bounded, needs
no permission, and is defined once in `PROBE_CATALOG` in `core.mjs` — the
interface, the score, the export and this table all read from that one list.

| Probe | Category | Weight | Reads |
| --- | --- | --- | --- |
| `screen` | `display` | 8 | Screen width/height, available area, colour and pixel depth, orientation type |
| `viewport` | `display` | 5 | Window inner/outer size and device pixel ratio |
| `timezone` | `locale` | 8 | IANA time zone, current UTC offset, resolved locale, calendar, numbering system |
| `languages` | `locale` | 7 | Ordered preferred-language list, capped at 8 entries |
| `ua` | `platform` | 10 | User agent, platform, vendor, and an engine family label derived from them |
| `clientHints` | `platform` | 6 | Low-entropy client hints only: brand list, mobile flag, coarse platform |
| `touch` | `input` | 4 | Maximum touch points, pointer coarseness, any-hover, pointer event support |
| `cores` | `hardware` | 6 | Logical processor count, clamped to 1–64 |
| `memory` | `hardware` | 5 | Approximate device memory in GiB, where the browser exposes it |
| `canvas` | `rendering` | 12 | A short local digest of a fixed 240×60 drawing, plus text metrics and a pixel sample |
| `webgl` | `rendering` | 12 | Vendor, renderer, version, shading language version, max texture size, extension count |
| `fonts` | `rendering` | 8 | Which of 25 candidate font names appear to be available, by width comparison |
| `prefs` | `preferences` | 5 | Reduced motion, colour scheme, contrast, forced colours, reduced transparency |
| `storage` | `storage` | 6 | Whether cookies, local storage, session storage and IndexedDB are usable |

Deliberately excluded: anything that triggers a permission prompt, the
high-entropy client hint API, audio-stack fingerprinting, battery status, media
device enumeration, and WebRTC. GLASSHOUSE reads WebGL capability strings but
never reads WebGL pixels.

### Probe outcomes

Each probe reports exactly one status:

| Status | Meaning |
| --- | --- |
| `ok` | The browser returned a usable reading |
| `unsupported` | The signal is not exposed by this browser |
| `denied` | The browser or your settings blocked the read |
| `error` | The read was attempted and failed |

An `ok` reading is graded for detail. `full` means the reading was specific;
`coarse` means it succeeded but was masked or low-detail. The three coarse rules
are published in `core.mjs` and are the only ones that exist:

- `webgl` is coarse when the renderer string matches a masked/software hint
  (`offscreen`, `swiftshader`, `llvmpipe`, `software`, `generic renderer`,
  `unknown`, `masked`).
- `clientHints` is coarse when a brand list is present but the platform is not.
- `canvas` is coarse when the digest is shorter than 8 characters.

## Exposure score

The score is a deliberately boring, fully auditable sum. There is no hidden
model and no calibration data.

```
points(signal) = status === 'ok' ? min(weight, ceil(weight × detailFactor)) : 0
detailFactor   = full 1 · coarse 0.5 · none 0
category       = min(cap, sum of that category's signal points)
total          = sum of the eight category points
percent        = round(total / 88 × 100)
```

Coarse credit uses `ceil`, so an odd weight rounds up: a coarse `languages`
reading is worth 4 of 7, not 3.5.

| Category | Name | Cap | Uncapped probe weight | Probes |
| --- | --- | --- | --- | --- |
| `display` | Display & geometry | 11 | 13 | screen, viewport |
| `locale` | Locale & time | 13 | 15 | timezone, languages |
| `platform` | Platform identity | 14 | 16 | ua, clientHints |
| `input` | Input capabilities | 4 | 4 | touch |
| `hardware` | Hardware hints | 9 | 11 | cores, memory |
| `rendering` | Rendering surfaces | 26 | 32 | canvas, webgl, fonts |
| `preferences` | User preferences | 5 | 5 | prefs |
| `storage` | Storage & state | 6 | 6 | storage |

Caps sum to **88**, which is the maximum total. Six of the eight categories can
saturate — the uncapped weight of their probes exceeds the cap — which is the
point: no single family of probes can dominate the headline figure. A browser
that leaks everything about its GPU still cannot push `rendering` past 26.

Bands are descriptive labels over the percentage, not judgements:

| Percent | Band |
| --- | --- |
| 0–24 | Narrow surface |
| 25–49 | Moderate surface |
| 50–74 | Elevated surface |
| 75–100 | Broad surface |

Every figure on screen is traceable: the interface prints the formula verbatim
from `SCORE_FORMULA`, each signal card shows its own `points of weight`, and each
category row shows its cap and flags itself when the cap bit.

## Controls

| Control | Effect |
| --- | --- |
| **Run again** | Re-runs all 14 probes and re-compares against the stored snapshot |
| **Save JSON report** | Writes a report to a local file. Nothing is transmitted |
| **Include the raw observed values** | Opt-in checkbox controlling whether that file contains the readings themselves |
| **Delete local data** | Removes both stored keys immediately and clears the comparison panel |
| **Report A** / **Report B** | Two local file pickers for [Mirror Match](#mirror-match). Nothing is uploaded |
| **Compare reports** | Compares the two chosen reports in this tab |
| **Include the exact value changes** | Opt-in checkbox for the saved comparison, effective only when both reports carry values |
| **Save comparison JSON** | Writes the comparison to a local file, with exact values omitted by default |
| **Clear imported reports** | Discards both imported reports from memory at once |
| **Start echo test** | Runs the 14 probes 3 sequential runs in a row for [Echo Test](#echo-test), in memory only |
| **Include all exact readings that the runs returned** | Opt-in checkbox controlling whether the saved echo file carries the readings themselves |
| **Save echo JSON** | Writes the experiment to a local file, with the readings omitted by default |
| **Clear echo test** | Discards every recorded run immediately, and cancels a run still in flight |

Every control is a real `<button>` or labelled `<input>`, reachable and operable
by keyboard, with a visible focus ring. Progress is a `<progress>` element and
status updates are announced through a polite live region. Statuses are conveyed
with a text label and a symbol as well as colour. The canvas backdrop is
switched off entirely — not merely slowed — when `prefers-reduced-motion: reduce`
is set, and the layout is built mobile-first from 360px upward.

## Privacy boundary

- No telemetry, analytics, tracking, error reporting or submission of any kind.
- No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`
  anywhere in the repository. `verify.mjs` asserts their absence.
- No CDN, external font, external stylesheet, external script, image, iframe or
  media element. All visuals are original CSS and canvas drawing, using the
  system font stack.
- No service worker and no cache manipulation.
- No cookies are set by this page.
- No permission is ever requested, so no permission prompt can appear.
- Observations exist in memory and, for one snapshot, in this browser's local
  storage. They are never sent anywhere.
- Reports you import for [Mirror Match](#mirror-match) are read from your own
  disk into this tab's memory only. They are never persisted and never sent.
- Every run recorded by [Echo Test](#echo-test) exists in this tab's memory only.
  It is never persisted and never sent, so a reload discards all of it.

## Stored data

Two `localStorage` keys, both local to your browser and both removable from the
page:

| Key | Contents | Written when |
| --- | --- | --- |
| `glasshouse.snapshot.v1` | The most recent normalised snapshot, so the next run can show what changed. One entry; each run replaces it | After every completed run |
| `glasshouse.settings.v1` | Whether the raw-values checkbox is ticked | When you toggle that checkbox |

Nothing else is persisted. **Delete local data** removes both keys. If storage is
blocked, the page still works; it simply has nothing to compare against.

## Report

**Save JSON report** builds the report with `buildReport()` in `core.mjs` and
serialises it with `stableStringify()`, which sorts object keys — so two
identical snapshots produce byte-identical files that you can diff or checksum
locally.

Redaction is the default, and it is deliberate rather than incidental:

- With the checkbox **off**, every signal's `value`, `display` and `reason` keys
  are removed and replaced with `valueOmitted: true`. What remains is the audit
  trail — probe id, label, category, status, detail grade, weight and points —
  so anyone can re-derive the total without learning anything about your device.
  The file states this in a `redaction` block, so a reader cannot mistake the
  omission for a bug.
- With the checkbox **on**, the readings are included and
  `includesRawValues: true` says so explicitly.

Only a literal boolean `true` opts in; that is covered by a test, so a truthy
value such as the string `"true"` cannot silently include your data.

## Mirror Match

**Mirror Match** compares two reports you have already saved. It is the answer to
"did that setting actually change anything?" — and it runs entirely in the tab,
against two files you choose from your own disk.

### Workflow

1. Save a report (**Save JSON report**), change something — a browser setting, a
   privacy extension, a different browser — then save a second report.
2. Choose the earlier file as **Report A** and the later one as **Report B**.
3. Press **Compare reports**.
4. Optionally press **Save comparison JSON** to keep the comparison as a file.
5. Press **Clear imported reports** to discard both immediately.

The comparison always runs from A to B, so a negative delta means less was
readable in B than in A. It shows:

- each report's own total, maximum, percentage and band;
- the total delta and a per-category delta, with category deltas that sum to the
  total delta;
- per-signal status, detail-grade and points changes, each classified as
  `increased`, `decreased` or `unchanged` exposure;
- exact normalised value changes, but only when both files carry their values.

### Privacy boundary for imports

Imports are strictly local, and this is enforced structurally rather than
promised:

- Both files are read with the chosen `File` object's own `text()` reader. There
  is no upload, no `fetch`, and no form submission.
- Imported reports are **never written to** `localStorage`, session storage,
  IndexedDB, the cache API or a cookie. They live in one module-scope object in
  the tab and nowhere else.
- Because nothing is persisted, a **reload** or a closed tab discards both
  imports. There is nothing to delete afterwards.
- `verify.mjs` slices the delimited `mirror match` region out of `index.html` and
  asserts that none of those persistence or networking APIs appear in it at all.

### Report compatibility

Mirror Match reads files this build produced: `report version 1` and
`snapshot version 1`, with all 14 catalog probes present exactly once. Nothing in
a file is taken on trust. Labels, categories, weights, caps, bands and every
total are re-derived from `PROBE_CATALOG` in `core.mjs`, and the file's own
arithmetic is recomputed and compared before anything is displayed — so a
hand-edited total cannot be shown as fact, and text in a file cannot reach the
page.

A file larger than **256 KiB** (`262144` bytes, measured in UTF-8 bytes) is
refused without being read. A genuine report is a few kilobytes.

Validation is atomic: either both files pass and a comparison appears, or nothing
is imported, no comparison is shown, and every reason is listed. Each reason has
a stable code:

| Code | Meaning |
| --- | --- |
| `no-file` | No file was chosen for that side |
| `unreadable` | The file could not be read from disk |
| `not-text` | The input was not text |
| `too-large` | Larger than the 256 KiB bound; not read |
| `empty` | The file has no content |
| `malformed-json` | Not valid JSON |
| `not-object` | Valid JSON, but not an object at the root |
| `foreign-report` | Does not identify itself as a GLASSHOUSE report |
| `unsupported-version` | A report or snapshot version this build does not read |
| `raw-flag-invalid` | `includesRawValues` is not a literal `true` or `false` |
| `signals-missing` | No signals array |
| `unknown-probe` | A probe id this build does not have |
| `duplicate-probe` | The same probe listed more than once |
| `missing-probe` | A catalog probe absent from the file |
| `invalid-status` | A status outside `ok`/`unsupported`/`denied`/`error` |
| `invalid-detail` | A detail grade that its status cannot carry |
| `invalid-weight` | A weight that disagrees with the catalog |
| `invalid-points` | Points that disagree with the published formula |
| `score-missing` | No score block with a categories array |
| `score-bounds` | A total or maximum outside the possible range |
| `score-inconsistent` | A total, percentage or band the signals do not support |
| `category-inconsistent` | A category cap or total the signals do not support |
| `raw-values-missing` | Claims to include values, but a probe has none |
| `raw-values-invalid` | A value that cannot support its own declared grade |

### Redacted versus raw

A **redacted** report — the default when you save one — is fully useful here. The
whole **structural** comparison (statuses, detail grades, points, category totals
and the headline delta) is derived from the audit trail, which redaction keeps.

Exact value changes are a separate, narrower thing. They appear only when *both*
files declare `includesRawValues: true` and their values still normalise to the
grades they claim. If either side is redacted, the page says so in as many words
— that exact value comparison is unavailable while the structural comparison
remains valid — instead of guessing. One redacted side withdraws every exact
comparison, including from the open side.

Consent is never inferred: only a literal boolean opts a file in, so a report
whose flag is the string `"true"` is refused rather than read as raw.

### The comparison file

**Save comparison JSON** goes through `buildComparisonExport()` and
`stableStringify()`, so it is byte-reproducible and diffable.

- By default it is written as `glasshouse-comparison-redacted.json`, with the
  `valueBefore`, `valueAfter`, `displayBefore` and `displayAfter` keys removed
  from every signal and replaced with `valuesOmitted: true`. That a reading
  changed is kept; what it was is not.
- Tick **Include the exact value changes** and it is written as
  `glasshouse-comparison-with-values.json` instead. As with the report export,
  only a literal boolean `true` opts in, and opting in cannot conjure values that
  a redacted pair never carried — the file then says
  `includesExactValues: false` and explains why.

Either way the file identifies both sides honestly: each report's save time, its
own redaction state, and its own totals, alongside a `semantics` block stating
what the comparison does and does not mean.

### What a comparison does not tell you

- It compares two files, not two devices. It cannot tell you whether the same
  machine produced both, and it does not try to.
- A smaller total in B means these particular probes returned less. It is not a
  privacy score, and the [Limitations](#limitations) above apply unchanged to
  both sides.
- A signal that changed value between two runs on one machine usually means
  deliberate randomisation, not a different device.
- Nothing here compares either report against any other person or population.

## Echo Test

A scan tells you what could be read once. **Echo Test** asks the narrower,
more useful question: *which of those answers hold still?* It reads the same 14
probes for 3 sequential runs in a row, in this tab, and then classifies every
signal by what actually happened across those runs.

It adds no new probe. Every run goes through the same collection path the
ordinary scan uses, so the experiment cannot ask your browser for anything the
page has not already disclosed, and it cannot drift from a normal run.

### Workflow

1. Press **Start echo test**.
2. Watch the status line count the runs — `Run 1 of 3`, then `Run 2 of 3`.
   **Clear echo test** stays operable the whole time, so you can withdraw
   part-way through.
3. Read the per-signal classifications, the per-category tally and the plain
   language evidence behind each one.
4. Optionally press **Save echo JSON** to keep the experiment as a file.
5. Press **Clear echo test** to discard every recorded run immediately.

### Classifications

Each signal receives exactly one of four outcomes, derived in `core.mjs` and
published there as data:

| Code | Label | Meaning |
| --- | --- | --- |
| `stable` | Stable | At least two runs returned a reading, every reading was identical, and the outcome never changed |
| `variable` | Variable | At least two runs returned a reading and at least one differed from another, with no change of outcome |
| `intermittent` | Intermittent | The outcome itself changed between runs — any transition among readable, blocked, unsupported or failing |
| `unavailable` | Not enough evidence | Fewer than two runs returned a reading and the outcome never changed, so there was nothing to compare |

The precedence is deliberate: a status change **outranks** any value
comparison. A probe that answers once and refuses later is reported as
`intermittent` whatever its values did, because it cannot be relied on in
either direction. Equally, a single reading is never called `stable` — with
nothing to compare it against, `unavailable` is the honest answer, not a zero.

Values are compared with the same deterministic serialisation the rest of the
page uses, so a map whose keys arrive in a different order is not mistaken for a
change, while a list whose order changed genuinely is one.

Category summaries and the overall tally are counted from these per-signal
classifications and from nothing else: every category's four counts add up to
its own probe count, and the overall counts add up to 14.

### Privacy boundary for the experiment

- Every recorded run lives in one module-scope object in this tab. Runs are
  **never written to** `localStorage`, session storage, IndexedDB, the Cache API
  or a cookie, and never sent anywhere.
- Because nothing is persisted, a **reload** or a closed tab discards every run.
  There is nothing to delete afterwards.
- **Clear echo test** discards the recorded runs and cancels a run still in
  flight. A run you cancel cannot come back: it will not repopulate state, will
  not render, and will not re-enable the export when its last probe finishes.
- Conflicting controls are disabled while a run is in progress, but **Clear echo
  test** is not, so consent can be withdrawn at any moment.
- No permission is requested, and no probe outside the published catalog is used.
- `verify.mjs` slices the delimited `echo test` region out of `index.html` and
  asserts that no persistence or networking API appears in it at all, that it
  invokes no probe collector of its own, and that its cancellation guards sit
  before the commit.

### The echo file

**Save echo JSON** goes through `buildEchoExport()` and `stableStringify()`, so
it is byte-reproducible and diffable.

- By default it is written as `glasshouse-echo-redacted.json`, with the `values`
  and `displays` keys removed from every signal and replaced with
  `valuesOmitted: true`. The classification, the outcome in each run, the number
  of distinct readings, whether the reading changed and the evidence sentence are
  all kept — so the experiment stays auditable without describing your device.
- Tick **Include all exact readings that the runs returned** and it is written as
  `glasshouse-echo-with-values.json` instead. Only a literal boolean `true`
  opts in, so a truthy value cannot silently include your readings, and opting in
  cannot conjure values that no run ever produced.
- When the readings are included, the file carries a `valuesWarning` saying in as
  many words that it may reveal details about this device and browser.
- Either way the `exactValues` block states whether values were `available` and
  whether they were `included`, so a reader cannot mistake redaction for a bug.

### What an echo test does not tell you

- It measures repeatability within one browser session, not how recognisable you
  are. The [Limitations](#limitations) above apply unchanged.
- `stable` across 3 runs a few seconds apart does not mean stable forever. A
  browser restart, an update or a settings change can move any of it.
- `variable` is usually a browser deliberately varying its answer, which is a
  defence working — but it is not a promise that the signal is unusable.
- Nothing here compares your results against any other person or population.

## Local preview

Serve the two browser files over a local HTTP server so ES-module loading follows
the same-origin rules used by GitHub Pages. No package installation is needed.
(Some browsers block module imports from `file://`, so opening the file directly
is not a portable preview method.)

```sh
cd glasshouse
python3 -m http.server 8080
# then open http://localhost:8080/
```

To confirm the offline claim: load the page once, disconnect the network, and
press **Run again**. Everything still works, because nothing was ever fetched.

## Verification

```sh
node verify.mjs                       # everything: exits nonzero on failure
node verify.mjs --only 'core/score'   # one focused slice
node verify.mjs --list                # list test names
node --check core.mjs                 # syntax check the module
```

`verify.mjs` has no dependencies and uses only Node built-ins. It runs the
deterministic unit tests for normalization, scoring, redaction and comparison,
and it also enforces structural gates that a unit test cannot:
- `index.html` has no absolute URL, external resource, or networking API, and
  imports `./core.mjs`.
- The page defines a collector for every catalog probe, calls the tested core
  functions, and does not contain a second copy of the scoring, redaction or
  comparison logic.
- No permission-requesting or high-entropy API appears in the page.
- The inline module is extracted to a temporary file and parsed with
  `node --check`, so the page's script cannot be syntactically broken silently.
- `core.mjs` references no browser global, no clock and no randomness, with
  string literals and comments stripped before the scan so probe copy cannot
  create a false pass.
- This README's probe list, weights, category caps, maximum total and band
  labels are checked against `core.mjs` itself, so the documentation cannot
  drift from the code.
- The delimited `mirror match` region of `index.html` contains no persistence or
  networking API at all, enforces the size bound before reading a file, and
  commits imported state only after both files have validated.
- The rejection codes this README documents are compared against the codes the
  validator can actually emit, so neither list can drift.
- The delimited `echo test` region of `index.html` contains no persistence or
  networking API at all, invokes no probe collector of its own, and commits an
  experiment only after its cancellation guard has passed.
- This README's echo run count, classification codes, classification labels and
  export file names are checked against `core.mjs`, so they cannot drift either.

## Licence

No licence has been chosen yet, so all rights are reserved by default. The code
is written to be read: two files, no build step, no minification.
