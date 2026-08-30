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

/** Normalize any leaf value into a string, finite number, boolean, list or null. */
function normalizeScalar(input) {
  if (typeof input === 'string') return normalizeString(input);
  if (typeof input === 'number') return normalizeNumber(input);
  if (typeof input === 'boolean') return input;
  if (Array.isArray(input)) {
    const items = [];
    for (const item of input) {
      const normalized = normalizeScalar(item);
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
