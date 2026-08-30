/**
 * GLASSHOUSE deterministic core.
 *
 * Pure data-in / data-out functions: normalization, scoring, report redaction
 * and snapshot comparison. No browser or global environment dependency, no
 * network access, no I/O, no mutation of arguments.
 *
 * Production logic is added one tested vertical slice at a time (see
 * TDD_EVIDENCE.md).
 */

/**
 * Scoring categories. Each category has a hard cap, so no single category can
 * dominate the exposure surface figure. `cap` is in raw weight points.
 */
export const CATEGORIES = Object.freeze({
  display: Object.freeze({ label: 'Display & geometry', cap: 11 }),
  locale: Object.freeze({ label: 'Locale & time', cap: 13 }),
  platform: Object.freeze({ label: 'Platform identity', cap: 14 }),
  input: Object.freeze({ label: 'Input capabilities', cap: 4 }),
  hardware: Object.freeze({ label: 'Hardware hints', cap: 9 }),
  rendering: Object.freeze({ label: 'Rendering surfaces', cap: 26 }),
  preferences: Object.freeze({ label: 'User preferences', cap: 5 }),
  storage: Object.freeze({ label: 'Storage & state', cap: 6 }),
});

/**
 * The probe catalog is the single source of truth for which probes exist, what
 * they mean, what they are worth, and what a reader can do about them. The UI,
 * the score, the report and the README all derive from this list.
 */
export const PROBE_CATALOG = Object.freeze([
  {
    id: 'screen',
    keys: ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'orientation'],
    label: 'Screen geometry & colour depth',
    category: 'display',
    kind: 'map',
    weight: 8,
    explanation:
      'The browser reports the size of your screen, the space left after system chrome, and how many bits per pixel it uses for colour. Together these values describe your physical display rather than just this window.',
    mitigation:
      'Use a maximised window at a common resolution, or a browser that quantises screen metrics. Unusual multi-monitor sizes stand out most.',
  },
  {
    id: 'viewport',
    keys: ['innerWidth', 'innerHeight', 'devicePixelRatio', 'outerWidth', 'outerHeight'],
    label: 'Viewport & pixel ratio',
    category: 'display',
    kind: 'map',
    weight: 5,
    explanation:
      'The current window size and the device pixel ratio are readable by any page. The ratio hints at display density and at browser or operating system zoom.',
    mitigation:
      'Keep zoom at 100% and avoid unusual window sizes if you want to blend in. Resizing between visits changes this value but does not hide it.',
  },
  {
    id: 'timezone',
    keys: ['timeZone', 'utcOffsetMinutes', 'locale', 'calendar', 'numberingSystem'],
    label: 'Time zone & regional formatting',
    category: 'locale',
    kind: 'map',
    weight: 8,
    explanation:
      'The internationalisation API exposes your IANA time zone name, your current offset from UTC, and the calendar and numbering system your locale uses. This is a coarse but stable location hint that survives address changes.',
    mitigation:
      'Set the browser or operating system to a common time zone, or use a browser that reports UTC. Note that a mismatched time zone can itself be distinctive.',
  },
  {
    id: 'languages',
    limit: 8,
    label: 'Preferred languages',
    category: 'locale',
    kind: 'list',
    weight: 7,
    explanation:
      'Pages can read your ordered list of preferred languages. Long or unusual lists, and rare region variants, are far more distinctive than a single common language.',
    mitigation:
      'Reduce the list to one widely used language in your browser language settings. Ordering matters as much as membership.',
  },
  {
    id: 'ua',
    keys: ['userAgent', 'platform', 'vendor', 'engineHint'],
    label: 'User agent & platform string',
    category: 'platform',
    kind: 'map',
    weight: 10,
    explanation:
      'The user agent string, the reported platform and the vendor field describe your browser family, engine and operating system. These are sent with every request as well as being readable here.',
    mitigation:
      'Keep your browser up to date so your string matches a large population, and prefer browsers that freeze or reduce the user agent. Ad-hoc spoofing often creates inconsistent combinations that stand out more.',
  },
  {
    id: 'clientHints',
    keys: ['brands', 'mobile', 'platform'],
    coarse: (value) => value.platform === null,
    label: 'Low-entropy client hints',
    category: 'platform',
    kind: 'map',
    weight: 6,
    explanation:
      'Chromium-based browsers expose a structured brand list, a mobile flag and a coarse platform name without any permission. GLASSHOUSE deliberately never requests the high-entropy hints such as full version, model or architecture.',
    mitigation:
      'This surface is intentionally coarse by design. Browsers that do not implement client hints simply report nothing here.',
  },
  {
    id: 'touch',
    keys: ['maxTouchPoints', 'pointer', 'anyHover', 'pointerEvents'],
    label: 'Touch & pointer capability',
    category: 'input',
    kind: 'map',
    weight: 4,
    explanation:
      'The maximum number of simultaneous touch points, plus the pointer and hover media queries, describe your input hardware class: touchscreen, mouse, stylus or a hybrid device.',
    mitigation:
      'Little can be changed here without breaking usability. The value is stable but low in detail on its own.',
  },
  {
    id: 'cores',
    range: { min: 1, max: 64, decimals: 0 },
    label: 'Logical processor count',
    category: 'hardware',
    kind: 'number',
    weight: 6,
    explanation:
      'The browser reports how many logical CPU cores are available to it. This is a hardware class hint that changes only when you change machine.',
    mitigation:
      'Some privacy-focused browsers clamp or round this value. Otherwise it cannot be hidden from a page.',
  },
  {
    id: 'memory',
    range: { min: 0.25, max: 1024, decimals: 2 },
    label: 'Approximate device memory',
    category: 'hardware',
    kind: 'number',
    weight: 5,
    explanation:
      'Where implemented, the browser reports approximate installed RAM in gibibytes, already rounded into coarse buckets by the specification. Not all browsers expose it.',
    mitigation:
      'Browsers that omit this property report nothing here, which is the more private behaviour.',
  },
  {
    id: 'canvas',
    keys: ['digest', 'textDigest', 'pixelSample', 'dataLength'],
    coarse: (value) => typeof value.digest !== 'string' || value.digest.length < 8,
    label: 'Canvas rendering digest',
    category: 'rendering',
    kind: 'map',
    weight: 12,
    explanation:
      'Drawing the same shapes and text into a canvas and reading the pixels back can produce slightly different output on different graphics stacks. GLASSHOUSE reduces that output to a short local digest and never uploads it.',
    mitigation:
      'Use a browser that randomises or blocks canvas readback, or that prompts before allowing it. A digest that changes on every run indicates active protection.',
  },
  {
    id: 'webgl',
    keys: ['vendor', 'renderer', 'version', 'shadingLanguage', 'maxTextureSize', 'extensionCount'],
    coarse: (value) => typeof value.renderer !== 'string' || isMaskedRenderer(value.renderer),
    label: 'WebGL capabilities',
    category: 'rendering',
    kind: 'map',
    weight: 12,
    explanation:
      'When a WebGL context is available, the driver may expose a renderer and vendor description along with hardware limits such as maximum texture size. This is one of the most detailed hardware surfaces a page can read without permission.',
    mitigation:
      'Browsers that mask the debug renderer info, or that disable WebGL entirely, reduce this substantially. GLASSHOUSE reads only capability strings and limits, never pixels.',
  },
  {
    id: 'fonts',
    limit: 25,
    label: 'Font availability sample',
    category: 'rendering',
    kind: 'list',
    weight: 8,
    explanation:
      'By measuring text width against fallback fonts, a page can infer which of a fixed candidate list is installed. Installed font sets reflect the operating system plus anything you have added.',
    mitigation:
      'Use a browser that restricts font enumeration or ships a fixed font allow-list. GLASSHOUSE tests only a small bounded candidate list.',
  },
  {
    id: 'prefs',
    keys: ['prefersReducedMotion', 'colorScheme', 'contrast', 'forcedColors', 'prefersReducedTransparency'],
    label: 'Accessibility & appearance preferences',
    category: 'preferences',
    kind: 'map',
    weight: 5,
    explanation:
      'Media queries expose your reduced-motion, colour scheme, contrast, forced-colours and reduced-transparency preferences. These exist so sites can respect your needs, and are readable as a side effect.',
    mitigation:
      'These settings are worth keeping if you need them; the accessibility benefit generally outweighs the small amount of detail they add.',
  },
  {
    id: 'storage',
    keys: ['cookiesEnabled', 'localStorage', 'sessionStorage', 'indexedDB', 'storageManager'],
    label: 'Storage & cookie availability',
    category: 'storage',
    kind: 'map',
    weight: 6,
    explanation:
      'Whether cookies, local storage, session storage and IndexedDB are writable determines whether a site can keep an identifier on your device at all. This is the difference between recognising a device and re-deriving it.',
    mitigation:
      'Clear site data, use per-site storage partitioning, or block third-party cookies. GLASSHOUSE itself writes only the keys it discloses on this page.',
  },
].map(Object.freeze));

const PROBE_BY_ID = new Map(PROBE_CATALOG.map((probe) => [probe.id, probe]));

/** Look up a probe definition, or throw for an unknown id. */
export function getProbe(id) {
  const probe = PROBE_BY_ID.get(id);
  if (!probe) throw new TypeError(`unknown probe id: ${String(id)}`);
  return probe;
}

export const UNSUPPORTED_DISPLAY = 'Not exposed by this browser';

/** Every non-ok outcome has a fixed, explainable presentation. */
export const STATUS_DISPLAY = Object.freeze({
  unsupported: UNSUPPORTED_DISPLAY,
  denied: 'Blocked by browser or user settings',
  error: 'Could not be read',
});

export const STATUSES = Object.freeze(['ok', 'unsupported', 'denied', 'error']);

/**
 * Renderer strings that indicate a software or deliberately masked GPU string.
 * Listed openly because they change how the score is calculated.
 */
export const MASKED_RENDERER_HINTS = Object.freeze([
  'offscreen',
  'swiftshader',
  'llvmpipe',
  'software',
  'generic renderer',
  'unknown',
  'masked',
]);

export function isMaskedRenderer(renderer) {
  const lower = String(renderer).toLowerCase();
  return MASKED_RENDERER_HINTS.some((hint) => lower.includes(hint));
}

/** Hard bounds so a hostile or broken value can never bloat a snapshot. */
export const LIMITS = Object.freeze({
  string: 160,
  display: 200,
  listItems: 12,
  decimals: 3,
});

function normalizeString(input) {
  const collapsed = String(input)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.string);
  return collapsed.length === 0 ? null : collapsed;
}

function normalizeNumber(input) {
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;
  const factor = 10 ** LIMITS.decimals;
  return Math.round(input * factor) / factor;
}

/** Normalize a bounded leaf value into a string, finite number, boolean, list or null. */
function normalizeScalar(input, depth = 0) {
  if (depth > 4) return null;
  if (typeof input === 'string') return normalizeString(input);
  if (typeof input === 'number') return normalizeNumber(input);
  if (typeof input === 'boolean') return input;
  if (Array.isArray(input)) {
    const items = [];
    for (const item of input) {
      const normalized = normalizeScalar(item, depth + 1);
      if (normalized === null || Array.isArray(normalized)) continue;
      if (!items.includes(normalized)) items.push(normalized);
      if (items.length >= LIMITS.listItems) break;
    }
    return items.length === 0 ? null : items;
  }
  return null;
}

function renderLeaf(value) {
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

function clampDisplay(text) {
  if (text.length <= LIMITS.display) return text;
  return `${text.slice(0, LIMITS.display - 1)}\u2026`;
}

function normalizeMapValue(probe, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  let populated = 0;
  for (const key of probe.keys) {
    const normalized = normalizeScalar(input[key]);
    out[key] = normalized;
    if (normalized !== null) populated += 1;
  }
  return populated === 0 ? null : out;
}

function normalizeListValue(probe, input) {
  if (!Array.isArray(input)) return { items: null, truncated: false };
  const items = [];
  let truncated = false;
  for (const entry of input) {
    const normalized = normalizeScalar(entry);
    if (normalized === null || Array.isArray(normalized)) continue;
    if (items.includes(normalized)) continue;
    if (items.length >= probe.limit) {
      truncated = true;
      break;
    }
    items.push(normalized);
  }
  return { items: items.length === 0 ? null : items, truncated };
}

function normalizeRangedNumber(probe, input) {
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;
  const { min, max, decimals } = probe.range;
  const factor = 10 ** decimals;
  const rounded = Math.round(input * factor) / factor;
  return Math.min(max, Math.max(min, rounded));
}

function describeValue(probe, value) {
  if (probe.kind === 'map') {
    const parts = [];
    for (const key of probe.keys) {
      if (value[key] === null || value[key] === undefined) continue;
      parts.push(`${key}: ${renderLeaf(value[key])}`);
    }
    return clampDisplay(parts.join('; '));
  }
  if (probe.kind === 'list') return clampDisplay(value.join(', '));
  return clampDisplay(renderLeaf(value));
}

/**
 * Normalize one raw probe observation into a stable signal record.
 *
 * @param {{id: string, status?: string, value?: unknown, reason?: string}} raw
 */
export function normalizeSignal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('raw signal must be an object');
  }
  const probe = getProbe(raw.id);
  const base = {
    id: probe.id,
    label: probe.label,
    category: probe.category,
    kind: probe.kind,
  };
  const blocked = (status, reason) => ({
    ...base,
    status,
    detail: 'none',
    value: null,
    display: STATUS_DISPLAY[status],
    reason: reason === undefined || reason === null ? null : normalizeString(reason),
    truncated: false,
  });

  const requested = raw.status === undefined || raw.status === null ? null : String(raw.status);
  if (requested !== null && !STATUSES.includes(requested)) {
    return blocked('error', `unsupported status: ${requested}`);
  }
  if (requested === 'denied' || requested === 'error' || requested === 'unsupported') {
    return blocked(requested, raw.reason);
  }

  if (raw.value === undefined || raw.value === null) return blocked('unsupported', raw.reason);

  let value;
  let truncated = false;
  if (probe.kind === 'map') {
    value = normalizeMapValue(probe, raw.value);
  } else if (probe.kind === 'list') {
    const list = normalizeListValue(probe, raw.value);
    value = list.items;
    truncated = list.truncated;
  } else if (probe.kind === 'number') {
    value = normalizeRangedNumber(probe, raw.value);
  } else {
    value = normalizeScalar(raw.value);
  }
  if (value === null) return blocked('unsupported', raw.reason);

  return {
    ...base,
    status: 'ok',
    detail: typeof probe.coarse === 'function' && probe.coarse(value) ? 'coarse' : 'full',
    value,
    display: describeValue(probe, value),
    reason: null,
    truncated,
  };
}

export const SNAPSHOT_VERSION = 1;

/**
 * Normalize a list of raw observations into a complete, ordered snapshot.
 * Missing probes are filled in as `unsupported`; later observations for the
 * same probe replace earlier ones. The input is never mutated.
 *
 * @param {Array<object>} rawSignals
 * @param {{createdAt?: string|null}} [options]
 */
export function normalizeSnapshot(rawSignals, options = {}) {
  if (!Array.isArray(rawSignals)) throw new TypeError('raw signals must be an array');

  const observed = new Map();
  for (const raw of rawSignals) {
    const signal = normalizeSignal(raw);
    observed.set(signal.id, signal);
  }

  const createdAt =
    options.createdAt === undefined || options.createdAt === null
      ? null
      : String(options.createdAt);

  return {
    version: SNAPSHOT_VERSION,
    createdAt,
    signals: PROBE_CATALOG.map(
      (probe) => observed.get(probe.id) ?? normalizeSignal({ id: probe.id }),
    ),
  };
}

/**
 * How much of a probe's weight each detail grade earns. Published here so the
 * UI and the README can quote the same rule.
 */
export const DETAIL_FACTORS = Object.freeze({
  full: 1,
  coarse: 0.5,
  none: 0,
});

/**
 * Score a single signal. Only an `ok` status can contribute, and the maximum
 * contribution is the probe's catalog weight. Coarse credit rounds up.
 */
export function scoreSignal(signal) {
  const probe = getProbe(signal && signal.id);
  const detail = signal.status === 'ok' ? (signal.detail ?? 'none') : 'none';
  const factor = DETAIL_FACTORS[detail] ?? 0;
  const points = Math.min(probe.weight, Math.ceil(probe.weight * factor));
  const reason =
    points === 0
      ? `no contribution: status ${signal.status ?? 'unknown'}, detail ${detail}`
      : `${detail} detail: ${points} of ${probe.weight} weight`;

  return {
    id: probe.id,
    label: probe.label,
    category: probe.category,
    status: signal.status ?? 'unknown',
    detail,
    weight: probe.weight,
    points,
    reason,
  };
}

/**
 * Bands describe how broad the readable surface is. They are deliberately
 * descriptive: no entropy estimate, no uniqueness probability, no verdict.
 */
export const SCORE_BANDS = Object.freeze([
  Object.freeze({
    id: 'narrow',
    minPercent: 0,
    label: 'Narrow surface',
    summary:
      'Few of the probes returned detailed readings. Your browser withheld or coarsened most of what was asked for.',
  }),
  Object.freeze({
    id: 'moderate',
    minPercent: 25,
    label: 'Moderate surface',
    summary:
      'A fair number of probes returned detail. This is typical of a mainstream browser with default settings.',
  }),
  Object.freeze({
    id: 'elevated',
    minPercent: 50,
    label: 'Elevated surface',
    summary:
      'Most probes returned detailed readings, including hardware-flavoured ones. Combinations like this are easier to re-recognise.',
  }),
  Object.freeze({
    id: 'broad',
    minPercent: 75,
    label: 'Broad surface',
    summary:
      'Nearly every probe returned full detail. This browser exposes a wide readable surface with little masking.',
  }),
]);

export const MAX_TOTAL = Object.values(CATEGORIES).reduce((sum, c) => sum + c.cap, 0);

export const SCORE_FORMULA =
  'points(signal) = status==="ok" ? min(weight, ceil(weight x detailFactor)) : 0; ' +
  'detailFactor: full=1, coarse=0.5, none=0; ' +
  'category points = min(cap, sum of its signal points); ' +
  `total = sum of category points; percent = round(total / ${MAX_TOTAL} x 100)`;

/** Pick the band for a percentage. Bands are ascending and cover 0-100. */
export function bandForPercent(percent) {
  let match = SCORE_BANDS[0];
  for (const band of SCORE_BANDS) {
    if (percent >= band.minPercent) match = band;
  }
  return match;
}

/**
 * Score a whole snapshot: contribution per signal, capped per category, summed.
 * Pure — the snapshot is read only and a fresh result is returned every call.
 */
export function scoreSnapshot(snapshot) {
  const signals = snapshot && Array.isArray(snapshot.signals) ? snapshot.signals : null;
  if (!signals) throw new TypeError('snapshot must have a signals array');

  const byId = new Map(signals.map((signal) => [signal.id, signal]));

  const categories = Object.entries(CATEGORIES).map(([id, category]) => {
    const contributions = PROBE_CATALOG.filter((probe) => probe.category === id).map((probe) => {
      const signal = byId.get(probe.id) ?? { id: probe.id, status: 'unsupported', detail: 'none' };
      return scoreSignal(signal);
    });
    const rawPoints = contributions.reduce((sum, c) => sum + c.points, 0);
    const points = Math.min(category.cap, rawPoints);
    return {
      id,
      label: category.label,
      cap: category.cap,
      rawPoints,
      points,
      capped: rawPoints > category.cap,
      contributions,
    };
  });

  const total = categories.reduce((sum, category) => sum + category.points, 0);
  const percent = MAX_TOTAL === 0 ? 0 : Math.round((total / MAX_TOTAL) * 100);

  return {
    total,
    maxTotal: MAX_TOTAL,
    percent,
    band: { ...bandForPercent(percent) },
    formula: SCORE_FORMULA,
    categories,
  };
}

/**
 * JSON with object keys sorted, so equal data always serializes identically.
 * Functions, symbols and undefined are dropped; non-finite numbers become null.
 *
 * @param {unknown} value
 * @param {number} [indent]
 */
export function stableStringify(value, indent = 0) {
  const sortKeys = (input) => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input && typeof input === 'object') {
      const out = {};
      for (const key of Object.keys(input).sort()) {
        const child = input[key];
        if (child === undefined || typeof child === 'function') continue;
        out[key] = sortKeys(child);
      }
      return out;
    }
    if (typeof input === 'number' && !Number.isFinite(input)) return null;
    if (input === undefined || typeof input === 'function') return null;
    return input;
  };

  return JSON.stringify(sortKeys(value), null, indent);
}

export const REPORT_VERSION = 1;

/**
 * localStorage keys GLASSHOUSE may write. Disclosed in the UI and the README.
 */
export const STORAGE_KEYS = Object.freeze({
  snapshot: 'glasshouse.snapshot.v1',
  settings: 'glasshouse.settings.v1',
});

export const REDACTED_KEYS = Object.freeze(['value', 'display', 'reason']);

/**
 * Strip every observed value from a report, leaving only the audit trail:
 * probe identity, status, detail grade and points.
 */
export function redactReport(report) {
  return {
    ...report,
    includesRawValues: false,
    redaction: {
      applied: true,
      removedKeys: [...REDACTED_KEYS],
      note: 'Observed values were deliberately omitted from this export. Statuses, detail grades and score points are kept so the total stays auditable.',
    },
    signals: report.signals.map((signal) => {
      const { value, display, reason, ...rest } = signal;
      return { ...rest, valueOmitted: true };
    }),
  };
}

/**
 * Build the exportable report for a snapshot.
 *
 * @param {object} snapshot
 * @param {{includeRawValues?: boolean}} [options]
 */
export function buildReport(snapshot, options = {}) {
  const includeRawValues = options.includeRawValues === true;
  const score = scoreSnapshot(snapshot);
  const pointsById = new Map();
  for (const category of score.categories) {
    for (const contribution of category.contributions) {
      pointsById.set(contribution.id, contribution);
    }
  }

  const report = {
    app: 'GLASSHOUSE',
    reportVersion: REPORT_VERSION,
    snapshotVersion: snapshot.version ?? SNAPSHOT_VERSION,
    createdAt: snapshot.createdAt ?? null,
    includesRawValues: true,
    redaction: { applied: false, removedKeys: [], note: 'Raw observed values are included at your request.' },
    notice:
      'Generated locally in the browser. Nothing in this file was uploaded by GLASSHOUSE. It describes what a page could read, not who you are.',
    score,
    signals: snapshot.signals.map((signal) => {
      const contribution = pointsById.get(signal.id);
      return {
        id: signal.id,
        label: signal.label,
        category: signal.category,
        status: signal.status,
        detail: signal.detail,
        truncated: signal.truncated === true,
        weight: contribution ? contribution.weight : getProbe(signal.id).weight,
        points: contribution ? contribution.points : 0,
        value: signal.value,
        display: signal.display,
        reason: signal.reason ?? null,
      };
    }),
  };

  return includeRawValues ? report : redactReport(report);
}

/**
 * Compare a previously stored snapshot with the current one.
 * Returns null when there is nothing to compare against.
 *
 * Change kinds:
 *   value        both runs read the probe, but the reading differs
 *   status       the outcome changed to an active refusal or failure
 *                (e.g. ok -> denied, or denied -> error)
 *   appeared     the probe reads now and did not before
 *   disappeared  the probe read before and is simply no longer exposed
 */
export function compareSnapshots(previous, current) {
  if (!previous || !Array.isArray(previous.signals)) return null;
  if (!current || !Array.isArray(current.signals)) return null;

  const prevById = new Map(previous.signals.map((s) => [s.id, s]));
  const currById = new Map(current.signals.map((s) => [s.id, s]));

  const changes = [];
  const stable = [];

  for (const probe of PROBE_CATALOG) {
    const before = prevById.get(probe.id);
    const after = currById.get(probe.id);
    if (!before && !after) continue;

    const beforeOk = Boolean(before) && before.status === 'ok';
    const afterOk = Boolean(after) && after.status === 'ok';
    const beforeStatus = before ? before.status : 'absent';
    const afterStatus = after ? after.status : 'absent';

    const entry = {
      id: probe.id,
      label: probe.label,
      category: probe.category,
      beforeStatus,
      afterStatus,
      before: before ? before.display : null,
      after: after ? after.display : null,
    };

    if (beforeOk && !afterOk) {
      // an active refusal or failure is a status change; a value that is simply
      // no longer exposed has disappeared
      const kind = afterStatus === 'denied' || afterStatus === 'error' ? 'status' : 'disappeared';
      changes.push({ ...entry, kind });
      continue;
    }
    if (!beforeOk && afterOk) {
      changes.push({ ...entry, kind: 'appeared' });
      continue;
    }
    if (beforeStatus !== afterStatus) {
      changes.push({ ...entry, kind: 'status' });
      continue;
    }
    if (
      beforeOk &&
      afterOk &&
      stableStringify(before.value) !== stableStringify(after.value)
    ) {
      changes.push({ ...entry, kind: 'value' });
      continue;
    }
    if (beforeOk && afterOk) stable.push(probe.id);
  }

  return {
    previousCreatedAt: previous.createdAt ?? null,
    currentCreatedAt: current.createdAt ?? null,
    changedCount: changes.length,
    changes,
    stable,
  };
}

/* ---------------------------------------------------------------------------
   MIRROR MATCH: importing two previously exported reports and comparing them.

   Everything here is pure and defensive. An imported report is untrusted
   input, so it is bounded, parsed, structurally validated and re-derived
   before any of it is trusted. Validation is atomic: either a complete
   report comes back, or nothing does and every reason is listed.
   --------------------------------------------------------------------------- */

/**
 * Conservative bound on an imported report. A genuine GLASSHOUSE export with
 * raw values is a few kilobytes; 256 KiB leaves generous headroom while making
 * a hostile or accidental multi-megabyte file a refusal rather than a stall.
 */
export const REPORT_IMPORT_LIMITS = Object.freeze({
  maxBytes: 262144,
  maxBytesLabel: '256 KiB',
});

/**
 * UTF-8 byte length of a string, computed arithmetically so the size bound
 * does not depend on any platform encoder.
 */
export function utf8ByteLength(text) {
  const input = String(text);
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.codePointAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      i += 1;
    }
  }
  return bytes;
}

/**
 * Every reason an import can be refused. Published as data so the interface,
 * the README and this validator cannot drift apart.
 */
export const REPORT_IMPORT_ERROR_CODES = Object.freeze([
  'not-text',
  'too-large',
  'empty',
  'malformed-json',
  'not-object',
  'foreign-report',
  'unsupported-version',
  'raw-flag-invalid',
  'signals-missing',
  'unknown-probe',
  'duplicate-probe',
  'missing-probe',
  'invalid-status',
  'invalid-detail',
  'invalid-weight',
  'invalid-points',
  'score-missing',
  'score-bounds',
  'score-inconsistent',
  'category-inconsistent',
  'raw-values-missing',
  'raw-values-invalid',
]);

/** Every rejection carries a stable code and a sentence a reader can act on. */
function importFailure(errors) {
  return { ok: false, errors, report: null };
}

function importError(code, message) {
  return { code, message };
}

/** Describe untrusted scalar fields without recursively serialising attacker-controlled data. */
function describeUntrusted(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  if (typeof value === 'string') {
    const clipped = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    return JSON.stringify(clipped);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[array]';
  return '[object]';
}

/**
 * Parse and validate the text of a previously exported GLASSHOUSE report.
 *
 * @param {string} text
 * @returns {{ok: boolean, errors: Array<{code: string, message: string}>, report: object|null}}
 */
export function parseReportText(text) {
  if (typeof text !== 'string') {
    return importFailure([
      importError('not-text', 'That input was not text, so it cannot be a JSON report.'),
    ]);
  }
  if (utf8ByteLength(text) > REPORT_IMPORT_LIMITS.maxBytes) {
    return importFailure([
      importError(
        'too-large',
        `That file is larger than the ${REPORT_IMPORT_LIMITS.maxBytesLabel} limit for an imported report, so it was not read.`,
      ),
    ]);
  }
  if (text.trim().length === 0) {
    return importFailure([importError('empty', 'That file is empty, so there is nothing to read.')]);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return importFailure([
      importError('malformed-json', 'That file is not valid JSON, so it could not be read.'),
    ]);
  }

  return validateReport(parsed);
}

/**
 * Validate an already-parsed report object.
 *
 * @param {unknown} input
 * @returns {{ok: boolean, errors: Array<{code: string, message: string}>, report: object|null}}
 */
export function validateReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return importFailure([
      importError(
        'not-object',
        'A report must be a JSON object. This file holds something else at its root.',
      ),
    ]);
  }
  if (input.app !== 'GLASSHOUSE') {
    return importFailure([
      importError(
        'foreign-report',
        'That file does not identify itself as a GLASSHOUSE report, so it was not imported.',
      ),
    ]);
  }
  if (input.reportVersion !== REPORT_VERSION) {
    return importFailure([
      importError(
        'unsupported-version',
        `This build reads report version ${REPORT_VERSION} only, and that file declares ${describeUntrusted(input.reportVersion)}.`,
      ),
    ]);
  }
  if (input.snapshotVersion !== SNAPSHOT_VERSION) {
    return importFailure([
      importError(
        'unsupported-version',
        `This build reads snapshot version ${SNAPSHOT_VERSION} only, and that file declares ${describeUntrusted(input.snapshotVersion)}.`,
      ),
    ]);
  }
  if (typeof input.includesRawValues !== 'boolean') {
    return importFailure([
      importError(
        'raw-flag-invalid',
        'A report must state whether it includes raw values with a true or false flag. Anything else is not treated as consent to read them.',
      ),
    ]);
  }

  if (!Array.isArray(input.signals)) {
    return importFailure([
      importError(
        'signals-missing',
        'That report has no signals array, so there is nothing to compare.',
      ),
    ]);
  }
  if (input.signals.length !== PROBE_CATALOG.length) {
    return importFailure([
      importError(
        'signals-missing',
        `That report must contain exactly ${PROBE_CATALOG.length} published signals.`,
      ),
    ]);
  }

  const errors = [];
  const seen = new Map();
  for (const entry of input.signals) {
    const id = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.id : null;
    if (typeof id !== 'string' || !PROBE_BY_ID.has(id)) {
      errors.push(
        importError(
          'unknown-probe',
          `That report contains a signal this build does not recognise: ${describeUntrusted(id)}.`,
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      errors.push(
        importError('duplicate-probe', `That report lists the probe "${id}" more than once.`),
      );
      continue;
    }
    seen.set(id, entry);
  }

  for (const probe of PROBE_CATALOG) {
    if (!seen.has(probe.id)) {
      errors.push(
        importError('missing-probe', `That report is missing the probe "${probe.id}".`),
      );
    }
  }

  if (errors.length > 0) return importFailure(errors);

  // Grades are enumerations, weights are catalog facts, and points are a
  // published function of status and detail. None of the three is taken on
  // trust from the file.
  const gradeErrors = [];
  for (const probe of PROBE_CATALOG) {
    const signal = seen.get(probe.id);
    if (!STATUSES.includes(signal.status)) {
      gradeErrors.push(
        importError(
          'invalid-status',
          `Probe "${probe.id}" declares the status ${describeUntrusted(signal.status)}, which is not one of ${STATUSES.join(', ')}.`,
        ),
      );
      continue;
    }
    const graded = signal.status === 'ok';
    const allowedDetail = graded ? ['full', 'coarse'] : ['none'];
    if (!allowedDetail.includes(signal.detail)) {
      gradeErrors.push(
        importError(
          'invalid-detail',
          `Probe "${probe.id}" is ${signal.status} but declares the detail grade ${describeUntrusted(signal.detail)}; ${allowedDetail.join(' or ')} was required.`,
        ),
      );
      continue;
    }
    if (signal.weight !== probe.weight) {
      gradeErrors.push(
        importError(
          'invalid-weight',
          `Probe "${probe.id}" declares weight ${describeUntrusted(signal.weight)}, but this build weights it ${probe.weight}.`,
        ),
      );
    }
    const expectedPoints = scoreSignal({ id: probe.id, status: signal.status, detail: signal.detail }).points;
    if (signal.points !== expectedPoints) {
      gradeErrors.push(
        importError(
          'invalid-points',
          `Probe "${probe.id}" declares ${describeUntrusted(signal.points)} points, but a ${signal.detail}-detail ${signal.status} reading is worth ${expectedPoints}.`,
        ),
      );
    }
  }
  if (gradeErrors.length > 0) return importFailure(gradeErrors);

  const score = input.score;
  if (!score || typeof score !== 'object' || Array.isArray(score) || !Array.isArray(score.categories)) {
    return importFailure([
      importError(
        'score-missing',
        'That report has no score block with a categories array, so its total cannot be checked.',
      ),
    ]);
  }

  const expected = scoreSnapshot({
    signals: PROBE_CATALOG.map((probe) => {
      const signal = seen.get(probe.id);
      return { id: probe.id, status: signal.status, detail: signal.detail };
    }),
  });

  const boundsErrors = [];
  if (score.maxTotal !== expected.maxTotal) {
    boundsErrors.push(
      importError(
        'score-bounds',
        `That report claims a maximum of ${describeUntrusted(score.maxTotal)} points; this build's maximum is ${expected.maxTotal}.`,
      ),
    );
  }
  if (!Number.isInteger(score.total) || score.total < 0 || score.total > expected.maxTotal) {
    boundsErrors.push(
      importError(
        'score-bounds',
        `That report's total of ${describeUntrusted(score.total)} is outside the possible range 0 to ${expected.maxTotal}.`,
      ),
    );
  }
  if (boundsErrors.length > 0) return importFailure(boundsErrors);

  const mathErrors = [];
  const expectedCategoryIds = new Set(expected.categories.map((category) => category.id));
  const declaredCategoryIds = score.categories.map((category) =>
    category && typeof category === 'object' && !Array.isArray(category) ? category.id : null,
  );
  if (
    score.categories.length !== expected.categories.length ||
    new Set(declaredCategoryIds).size !== declaredCategoryIds.length ||
    declaredCategoryIds.some((id) => !expectedCategoryIds.has(id))
  ) {
    mathErrors.push(
      importError(
        'category-inconsistent',
        'That report must contain each published scoring category exactly once and no unknown categories.',
      ),
    );
  }
  for (const category of expected.categories) {
    const declared = score.categories.find((c) => c && c.id === category.id);
    if (!declared) {
      mathErrors.push(
        importError('category-inconsistent', `That report omits the category "${category.id}".`),
      );
      continue;
    }
    if (declared.cap !== category.cap) {
      mathErrors.push(
        importError(
          'category-inconsistent',
          `Category "${category.id}" declares a cap of ${describeUntrusted(declared.cap)}; this build caps it at ${category.cap}.`,
        ),
      );
    }
    if (declared.points !== category.points) {
      mathErrors.push(
        importError(
          'category-inconsistent',
          `Category "${category.id}" declares ${describeUntrusted(declared.points)} points, but its signals add up to ${category.points}.`,
        ),
      );
    }
  }
  if (score.total !== expected.total) {
    mathErrors.push(
      importError(
        'score-inconsistent',
        `That report's total of ${score.total} does not match the ${expected.total} its own signals add up to.`,
      ),
    );
  }
  if (score.percent !== expected.percent) {
    mathErrors.push(
      importError(
        'score-inconsistent',
        `That report's percentage of ${describeUntrusted(score.percent)} does not match the ${expected.percent}% implied by its total.`,
      ),
    );
  }
  if (
    !score.band ||
    typeof score.band !== 'object' ||
    Array.isArray(score.band) ||
    score.band.id !== expected.band.id
  ) {
    mathErrors.push(
      importError(
        'score-inconsistent',
        `That report's band must be "${expected.band.label}" for ${expected.percent}%.`,
      ),
    );
  }
  if (mathErrors.length > 0) return importFailure(mathErrors);

  // Exact values are read only when the file declares raw inclusion with a
  // literal boolean, and only after each value has been put back through the
  // same normalization a live reading gets. A value that no longer supports
  // the grade the file claims is a rejection, not a downgrade.
  const includesRawValues = input.includesRawValues === true;
  const imported = new Map();
  if (includesRawValues) {
    const valueErrors = [];
    for (const probe of PROBE_CATALOG) {
      const signal = seen.get(probe.id);
      if (signal.status !== 'ok') {
        if (signal.value !== null && signal.value !== undefined) {
          valueErrors.push(
            importError(
              'raw-values-invalid',
              `Probe "${probe.id}" is ${signal.status}, so it must not carry an observed value.`,
            ),
          );
        }
        continue;
      }
      if (signal.value === null || signal.value === undefined) {
        valueErrors.push(
          importError(
            'raw-values-missing',
            `That report says it includes raw values, but probe "${probe.id}" has none.`,
          ),
        );
        continue;
      }
      const renormalized = normalizeSignal({ id: probe.id, value: signal.value });
      if (renormalized.status !== 'ok') {
        valueErrors.push(
          importError(
            'raw-values-invalid',
            `The recorded value for probe "${probe.id}" is not a usable reading.`,
          ),
        );
        continue;
      }
      if (renormalized.detail !== signal.detail) {
        valueErrors.push(
          importError(
            'raw-values-invalid',
            `The recorded value for probe "${probe.id}" grades as ${renormalized.detail} detail, but the report declares ${signal.detail}.`,
          ),
        );
        continue;
      }
      imported.set(probe.id, renormalized);
    }
    if (valueErrors.length > 0) return importFailure(valueErrors);
  }

  // Everything below is re-derived from the catalog and from the checked
  // arithmetic. Labels, categories, weights, caps and bands are never echoed
  // from the file, so a hand-edited report cannot inject text or inflate a
  // figure by relabelling itself.
  const report = {
    app: 'GLASSHOUSE',
    reportVersion: REPORT_VERSION,
    snapshotVersion: SNAPSHOT_VERSION,
    createdAt: typeof input.createdAt === 'string' ? normalizeString(input.createdAt) : null,
    includesRawValues: input.includesRawValues === true,
    redacted: input.includesRawValues !== true,
    score: {
      total: expected.total,
      maxTotal: expected.maxTotal,
      percent: expected.percent,
      band: { ...expected.band },
      categories: expected.categories.map((category) => ({
        id: category.id,
        label: category.label,
        cap: category.cap,
        points: category.points,
      })),
    },
    signals: PROBE_CATALOG.map((probe) => {
      const signal = seen.get(probe.id);
      const reading = imported.get(probe.id) ?? null;
      return {
        id: probe.id,
        label: probe.label,
        category: probe.category,
        kind: probe.kind,
        status: signal.status,
        detail: signal.detail,
        weight: probe.weight,
        points: signal.points,
        truncated: signal.truncated === true,
        value: reading ? reading.value : null,
        display: reading ? reading.display : null,
        reason:
          includesRawValues && typeof signal.reason === 'string'
            ? normalizeString(signal.reason)
            : null,
      };
    }),
  };

  return { ok: true, errors: [], report };
}

export const COMPARISON_VERSION = 1;

/**
 * What a Mirror Match comparison does and does not claim. Printed verbatim in
 * the interface and in the exported comparison file.
 */
export const COMPARISON_SEMANTICS =
  'A to B comparison of two GLASSHOUSE reports read on this device. Deltas describe how much of ' +
  'this fixed probe set was readable in each report and in how much detail. They are not a ' +
  'measure of uniqueness, identifiability or risk, and nothing here compares either report ' +
  'against any other person or population.';

const EXACT_VALUES_UNAVAILABLE =
  'At least one of these reports was saved with its observed values redacted, so exact value ' +
  'changes cannot be shown. The structural comparison below — statuses, detail grades, points ' +
  'and category totals — is unaffected and remains valid.';

const EXACT_VALUES_AVAILABLE =
  'Both reports were saved with their observed values included, so exact normalised value ' +
  'changes are shown alongside the structural comparison.';

function isImportedReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!value.score || typeof value.score !== 'object') return false;
  if (!Array.isArray(value.signals) || value.signals.length !== PROBE_CATALOG.length) return false;
  const ids = new Set(value.signals.map((signal) => signal && signal.id));
  return PROBE_CATALOG.every((probe) => ids.has(probe.id));
}

function comparisonSide(report) {
  return {
    createdAt: report.createdAt ?? null,
    includesRawValues: report.includesRawValues === true,
    redacted: report.includesRawValues !== true,
    total: report.score.total,
    maxTotal: report.score.maxTotal,
    percent: report.score.percent,
    band: { id: report.score.band.id, label: report.score.band.label },
  };
}

/**
 * Compare two imported reports, A then B.
 *
 * Both arguments must be reports returned by `parseReportText`/`validateReport`,
 * so their arithmetic has already been re-derived. Exact value changes appear
 * only when both sides explicitly included their observed values.
 *
 * @param {object} reportA
 * @param {object} reportB
 */
export function compareReports(reportA, reportB) {
  if (!isImportedReport(reportA) || !isImportedReport(reportB)) {
    throw new TypeError('compareReports needs two imported reports');
  }

  const exactAvailable =
    reportA.includesRawValues === true && reportB.includesRawValues === true;

  const beforeById = new Map(reportA.signals.map((signal) => [signal.id, signal]));
  const afterById = new Map(reportB.signals.map((signal) => [signal.id, signal]));
  const catBefore = new Map(reportA.score.categories.map((c) => [c.id, c]));
  const catAfter = new Map(reportB.score.categories.map((c) => [c.id, c]));

  const signals = PROBE_CATALOG.map((probe) => {
    const before = beforeById.get(probe.id);
    const after = afterById.get(probe.id);
    const pointsDelta = after.points - before.points;
    const statusChanged = before.status !== after.status;
    const detailChanged = before.detail !== after.detail;

    const valueComparison = !exactAvailable
      ? 'unavailable'
      : before.status !== 'ok' || after.status !== 'ok'
        ? 'not-read'
        : stableStringify(before.value) === stableStringify(after.value)
          ? 'same'
          : 'different';

    const changes = [];
    if (statusChanged) changes.push('status');
    if (detailChanged) changes.push('detail');
    if (pointsDelta !== 0) changes.push('points');
    if (valueComparison === 'different') changes.push('value');

    return {
      id: probe.id,
      label: probe.label,
      category: probe.category,
      weight: probe.weight,
      statusBefore: before.status,
      statusAfter: after.status,
      statusChanged,
      detailBefore: before.detail,
      detailAfter: after.detail,
      detailChanged,
      pointsBefore: before.points,
      pointsAfter: after.points,
      pointsDelta,
      exposure: pointsDelta > 0 ? 'increased' : pointsDelta < 0 ? 'decreased' : 'unchanged',
      changes,
      changed: changes.length > 0,
      valueComparison,
      valueBefore: exactAvailable ? (before.value ?? null) : null,
      valueAfter: exactAvailable ? (after.value ?? null) : null,
      displayBefore: exactAvailable ? (before.display ?? null) : null,
      displayAfter: exactAvailable ? (after.display ?? null) : null,
    };
  });

  const categories = Object.entries(CATEGORIES).map(([id, category]) => {
    const before = catBefore.get(id);
    const after = catAfter.get(id);
    return {
      id,
      label: category.label,
      cap: category.cap,
      before: before.points,
      after: after.points,
      delta: after.points - before.points,
    };
  });

  const a = comparisonSide(reportA);
  const b = comparisonSide(reportB);

  return {
    comparisonVersion: COMPARISON_VERSION,
    a,
    b,
    exactValues: {
      available: exactAvailable,
      reason: exactAvailable ? EXACT_VALUES_AVAILABLE : EXACT_VALUES_UNAVAILABLE,
    },
    totals: {
      before: a.total,
      after: b.total,
      delta: b.total - a.total,
      maxTotal: a.maxTotal,
      percentBefore: a.percent,
      percentAfter: b.percent,
      percentDelta: b.percent - a.percent,
      bandBefore: { ...a.band },
      bandAfter: { ...b.band },
      bandChanged: a.band.id !== b.band.id,
    },
    categories,
    signals,
    summary: {
      probeCount: signals.length,
      changedCount: signals.filter((s) => s.changed).length,
      increased: signals.filter((s) => s.exposure === 'increased').length,
      decreased: signals.filter((s) => s.exposure === 'decreased').length,
      unchanged: signals.filter((s) => s.exposure === 'unchanged').length,
      exactValueChanges: exactAvailable
        ? signals.filter((s) => s.valueComparison === 'different').length
        : null,
    },
    semantics: COMPARISON_SEMANTICS,
  };
}

/** The keys a redacted comparison export removes outright. */
export const COMPARISON_REDACTED_KEYS = Object.freeze([
  'valueBefore',
  'valueAfter',
  'displayBefore',
  'displayAfter',
]);

const COMPARISON_OMITTED_NOTE =
  'Exact value changes were deliberately omitted from this export. Which signals changed, and ' +
  'how their status, detail grade and points changed, is kept so the comparison stays auditable ' +
  'without describing either device.';

const COMPARISON_UNAVAILABLE_NOTE =
  'No exact value changes exist to export: at least one source report was saved with its ' +
  'observed values redacted. The structural comparison below is unaffected.';

/**
 * Build the exportable Mirror Match comparison file.
 *
 * Exact values are included only when the caller passes literal `true` and the
 * comparison actually has exact values available. Otherwise the four value
 * keys are removed from every signal and the omission is declared.
 *
 * @param {object} comparison result of compareReports()
 * @param {{includeExactValues?: boolean}} [options]
 */
export function buildComparisonExport(comparison, options = {}) {
  if (
    !comparison ||
    typeof comparison !== 'object' ||
    !Array.isArray(comparison.signals) ||
    !comparison.exactValues
  ) {
    throw new TypeError('buildComparisonExport needs a comparison from compareReports');
  }

  const available = comparison.exactValues.available === true;
  const includesExactValues = options.includeExactValues === true && available;

  return {
    app: 'GLASSHOUSE',
    kind: 'comparison',
    comparisonVersion: comparison.comparisonVersion,
    includesExactValues,
    redaction: {
      applied: !includesExactValues,
      removedKeys: includesExactValues ? [] : [...COMPARISON_REDACTED_KEYS],
      note: includesExactValues
        ? 'Exact value changes are included at your request.'
        : available
          ? COMPARISON_OMITTED_NOTE
          : COMPARISON_UNAVAILABLE_NOTE,
    },
    notice:
      'Generated locally in the browser by comparing two files you chose. Neither report was ' +
      'uploaded, transmitted or stored by GLASSHOUSE.',
    semantics: comparison.semantics,
    exactValues: {
      ...comparison.exactValues,
      reason: includesExactValues
        ? comparison.exactValues.reason
        : available
          ? 'Both source reports contained exact normalized values, but they were deliberately omitted from this export.'
          : comparison.exactValues.reason,
    },
    reports: { a: { ...comparison.a }, b: { ...comparison.b } },
    totals: { ...comparison.totals },
    categories: comparison.categories.map((category) => ({ ...category })),
    signals: comparison.signals.map((signal) => {
      if (includesExactValues) return { ...signal };
      const { valueBefore, valueAfter, displayBefore, displayAfter, ...rest } = signal;
      return { ...rest, valuesOmitted: true };
    }),
    summary: { ...comparison.summary },
  };
}
