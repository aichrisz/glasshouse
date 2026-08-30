# GLASSHOUSE

A zero-install, single-page browser inspection. It asks your browser the same
questions a tracking script would ask, shows you each answer as it arrives,
explains what the answer reveals and what you can do about it, and then stops.

Nothing is uploaded. There is no build step, no dependency, no package manager,
no service worker and no network request after the document has loaded. Open
`index.html` and it works — including with the network switched off.

Expected deployment: <https://aichrisz.github.io/glasshouse/>

- `index.html` — the entire interface: original CSS, a canvas backdrop, and one
  inline ES module that collects the probes and renders the results.
- `core.mjs` — every deterministic decision: normalization, scoring, report
  redaction and snapshot comparison. Pure functions, no browser globals.
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
  "Since your last run" panel that appears as values that keep changing. That is
  a protection working, not a fault.
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

## Licence

No licence has been chosen yet, so all rights are reserved by default. The code
is written to be read: two files, no build step, no minification.
