#!/usr/bin/env node
/**
 * GLASSHOUSE verifier.
 *
 * Dependency-free. Node built-ins only. No network access.
 *
 * Usage:
 *   node verify.mjs                 run every test
 *   node verify.mjs --only <text>   run only tests whose name contains <text>
 *   node verify.mjs --list          print test names
 *
 * Exits nonzero when any test fails.
 */
import { strict as assert } from 'node:assert';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from './core.mjs';

const argv = process.argv.slice(2);
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex === -1 ? null : argv[onlyIndex + 1];
const listOnly = argv.includes('--list');

/** @type {{name: string, fn: () => unknown}[]} */
const tests = [];

function test(name, fn) {
  if (tests.some((t) => t.name === name)) {
    throw new Error(`duplicate test name: ${name}`);
  }
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// tests are appended below, one vertical slice at a time
// ---------------------------------------------------------------------------

// slice 1 -- the probe catalog is the single source of truth for probes,
// categories, weights and copy.
test('core/catalog: declares >=10 probes with complete auditable metadata', () => {
  assert.ok(Array.isArray(core.PROBE_CATALOG), 'PROBE_CATALOG must be an array');
  assert.ok(
    core.PROBE_CATALOG.length >= 10,
    `expected >=10 probes, got ${core.PROBE_CATALOG.length}`,
  );

  const ids = core.PROBE_CATALOG.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'probe ids must be unique');

  assert.ok(core.CATEGORIES && typeof core.CATEGORIES === 'object', 'CATEGORIES must exist');

  for (const probe of core.PROBE_CATALOG) {
    assert.match(probe.id, /^[a-z][a-zA-Z0-9]*$/, `bad probe id: ${probe.id}`);
    for (const field of ['label', 'category', 'kind', 'explanation', 'mitigation']) {
      assert.equal(typeof probe[field], 'string', `${probe.id}.${field} must be a string`);
      assert.ok(probe[field].length > 0, `${probe.id}.${field} must not be empty`);
    }
    assert.ok(probe.explanation.length >= 30, `${probe.id}.explanation is too thin`);
    assert.ok(probe.mitigation.length >= 20, `${probe.id}.mitigation is too thin`);
    assert.equal(typeof probe.weight, 'number', `${probe.id}.weight must be a number`);
    assert.ok(
      Number.isInteger(probe.weight) && probe.weight > 0,
      `${probe.id}.weight must be a positive integer`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(core.CATEGORIES, probe.category),
      `${probe.id} references unknown category ${probe.category}`,
    );
  }

  for (const [id, category] of Object.entries(core.CATEGORIES)) {
    assert.equal(typeof category.label, 'string', `category ${id} needs a label`);
    assert.ok(
      Number.isInteger(category.cap) && category.cap > 0,
      `category ${id} needs a positive integer cap`,
    );
    assert.ok(
      core.PROBE_CATALOG.some((p) => p.category === id),
      `category ${id} has no probes`,
    );
  }
});

// slice 2 -- an unknown probe id is a programming error, not silent data.
test('core/normalize: rejects an unknown probe id', () => {
  assert.equal(typeof core.normalizeSignal, 'function', 'normalizeSignal must be a function');
  assert.throws(
    () => core.normalizeSignal({ id: 'notAProbe', value: 'x' }),
    /unknown probe id: notAProbe/,
  );
  assert.throws(() => core.normalizeSignal(null), /raw signal must be an object/);
});

// slice 3 -- an absent observation is an explicit, explainable state.
test('core/normalize: absent value becomes unsupported with no detail', () => {
  const signal = core.normalizeSignal({ id: 'memory' });
  assert.equal(signal.id, 'memory');
  assert.equal(signal.status, 'unsupported');
  assert.equal(signal.detail, 'none');
  assert.equal(signal.value, null);
  assert.equal(signal.display, 'Not exposed by this browser');
  assert.equal(signal.label, 'Approximate device memory');
  assert.equal(signal.category, 'hardware');
  assert.equal(core.normalizeSignal({ id: 'memory', value: null }).status, 'unsupported');
});

// slice 4 -- map probes expose only their declared keys, with tidy strings.
test('core/normalize: map values keep declared keys only and tidy strings', () => {
  const signal = core.normalizeSignal({
    id: 'ua',
    value: {
      userAgent: '  Mozilla/5.0   (X11;  Linux x86_64)  ',
      platform: 'Linux x86_64',
      injected: 'should be dropped',
      vendor: '',
    },
  });

  assert.equal(signal.status, 'ok');
  assert.deepEqual(Object.keys(signal.value), ['userAgent', 'platform', 'vendor', 'engineHint']);
  assert.equal(signal.value.userAgent, 'Mozilla/5.0 (X11; Linux x86_64)');
  assert.equal(signal.value.vendor, null, 'empty strings normalize to null');
  assert.equal(signal.value.engineHint, null, 'missing declared keys normalize to null');
  assert.equal(signal.display, 'userAgent: Mozilla/5.0 (X11; Linux x86_64); platform: Linux x86_64');

  const long = core.normalizeSignal({ id: 'ua', value: { userAgent: 'z'.repeat(400) } });
  assert.equal(long.value.userAgent.length, 160, 'long strings are clamped to 160 chars');
  assert.ok(long.display.length <= 200, `display clamped, got ${long.display.length}`);
});

// slice 5 -- list probes are bounded: order preserved, duplicates dropped,
// length capped by the probe's own declared limit.
test('core/normalize: list values dedupe, preserve order and honour the probe limit', () => {
  const languages = core.normalizeSignal({
    id: 'languages',
    value: ['en-GB', 'en-GB', ' en ', 'cy', 'en-GB'],
  });
  assert.deepEqual(languages.value, ['en-GB', 'en', 'cy']);
  assert.equal(languages.display, 'en-GB, en, cy');

  const limit = core.getProbe('languages').limit;
  assert.ok(Number.isInteger(limit) && limit > 0, 'languages probe must declare a limit');

  const many = Array.from({ length: limit + 6 }, (_, i) => `lang-${i}`);
  const clamped = core.normalizeSignal({ id: 'languages', value: many });
  assert.equal(clamped.value.length, limit);
  assert.equal(clamped.value[0], 'lang-0', 'clamping keeps the highest-priority entries');
  assert.equal(clamped.truncated, true, 'truncation is disclosed, not silent');
  assert.equal(languages.truncated, false);

  const fontLimit = core.getProbe('fonts').limit;
  assert.ok(fontLimit >= 12, `fonts limit should allow a real sample, got ${fontLimit}`);
});

// slice 6 -- numeric probes are clamped and rounded to their declared range,
// so an absurd or fractional reading cannot distort the report.
test('core/normalize: number values clamp and round to the declared range', () => {
  assert.equal(core.normalizeSignal({ id: 'cores', value: 8 }).value, 8);
  assert.equal(core.normalizeSignal({ id: 'cores', value: 8.7 }).value, 9, 'integers are rounded');
  assert.equal(core.normalizeSignal({ id: 'cores', value: 4096 }).value, 64, 'clamped to max');
  assert.equal(core.normalizeSignal({ id: 'cores', value: 0 }).value, 1, 'clamped to min');
  assert.equal(core.normalizeSignal({ id: 'cores', value: Number.NaN }).status, 'unsupported');
  assert.equal(core.normalizeSignal({ id: 'cores', value: 'eight' }).status, 'unsupported');

  const memory = core.normalizeSignal({ id: 'memory', value: 7.999 });
  assert.equal(memory.value, 8, 'memory keeps two decimals');
  assert.equal(core.normalizeSignal({ id: 'memory', value: 0.4567 }).value, 0.46);
  assert.equal(core.normalizeSignal({ id: 'cores', value: 12 }).display, '12');
});

// slice 7 -- a probe that was blocked or threw must stay explainable and must
// never leak a partial value into the report.
test('core/normalize: denied and error states keep a reason and drop the value', () => {
  const denied = core.normalizeSignal({
    id: 'storage',
    status: 'denied',
    value: { cookiesEnabled: true },
    reason: '  SecurityError: storage blocked\n',
  });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.detail, 'none');
  assert.equal(denied.value, null, 'a denied probe must not carry a value');
  assert.equal(denied.reason, 'SecurityError: storage blocked');
  assert.equal(denied.display, 'Blocked by browser or user settings');

  const failed = core.normalizeSignal({ id: 'canvas', status: 'error', reason: 'boom' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.value, null);
  assert.equal(failed.display, 'Could not be read');

  const bogus = core.normalizeSignal({ id: 'canvas', status: 'weird', value: { digest: 'abc' } });
  assert.equal(bogus.status, 'error', 'an unrecognised status degrades to error');
  assert.equal(bogus.reason, 'unsupported status: weird');

  const explicitOk = core.normalizeSignal({ id: 'cores', status: 'ok', value: 4 });
  assert.equal(explicitOk.status, 'ok');
  assert.equal(explicitOk.value, 4);

  const emptyOk = core.normalizeSignal({ id: 'cores', status: 'ok', value: undefined });
  assert.equal(emptyOk.status, 'unsupported', 'ok without a value is still unsupported');
});

// slice 8 -- a probe that succeeded but returned a masked or low-detail reading
// must score less than a fully detailed one.
test('core/normalize: masked readings are graded coarse rather than full', () => {
  const masked = core.normalizeSignal({
    id: 'webgl',
    value: { vendor: 'Brian Paul', renderer: 'Mesa OffScreen', maxTextureSize: 16384 },
  });
  assert.equal(masked.status, 'ok');
  assert.equal(masked.detail, 'coarse', 'a generic/masked renderer is coarse');

  const detailed = core.normalizeSignal({
    id: 'webgl',
    value: {
      vendor: 'Intel Inc.',
      renderer: 'Intel Iris Plus Graphics 640',
      maxTextureSize: 16384,
      extensionCount: 32,
    },
  });
  assert.equal(detailed.detail, 'full');

  const brandsOnly = core.normalizeSignal({ id: 'clientHints', value: { brands: ['Chromium'] } });
  assert.equal(brandsOnly.detail, 'coarse', 'brands without a platform is coarse');
  assert.equal(
    core.normalizeSignal({ id: 'clientHints', value: { brands: ['Chromium'], platform: 'Linux' } })
      .detail,
    'full',
  );

  const shortDigest = core.normalizeSignal({ id: 'canvas', value: { digest: 'ab12' } });
  assert.equal(shortDigest.detail, 'coarse', 'a truncated canvas digest is coarse');
  assert.equal(
    core.normalizeSignal({ id: 'canvas', value: { digest: 'a1b2c3d4e5f6', textDigest: '9f8e7d' } })
      .detail,
    'full',
  );
});

// slice 9 -- a snapshot is always complete and always in catalog order, so two
// runs are directly comparable no matter what order probes finished in.
test('core/snapshot: fills every probe in catalog order without mutating input', () => {
  const raw = [
    { id: 'cores', value: 4 },
    { id: 'timezone', value: { timeZone: 'Europe/London', utcOffsetMinutes: 60 } },
  ];
  const frozenCopy = JSON.stringify(raw);

  const snapshot = core.normalizeSnapshot(raw, { createdAt: '2026-01-02T03:04:05.000Z' });

  assert.equal(snapshot.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(snapshot.version, core.SNAPSHOT_VERSION);
  assert.deepEqual(
    snapshot.signals.map((s) => s.id),
    core.PROBE_CATALOG.map((p) => p.id),
    'signals follow catalog order and cover every probe',
  );

  const byId = Object.fromEntries(snapshot.signals.map((s) => [s.id, s]));
  assert.equal(byId.cores.status, 'ok');
  assert.equal(byId.cores.value, 4);
  assert.equal(byId.screen.status, 'unsupported', 'probes with no observation are filled in');
  assert.equal(JSON.stringify(raw), frozenCopy, 'input array must not be mutated');

  assert.equal(core.normalizeSnapshot([]).createdAt, null, 'createdAt is caller-supplied');
  assert.throws(() => core.normalizeSnapshot('nope'), /raw signals must be an array/);

  const duplicate = core.normalizeSnapshot([
    { id: 'cores', value: 4 },
    { id: 'cores', value: 16 },
  ]);
  const cores = duplicate.signals.find((s) => s.id === 'cores');
  assert.equal(cores.value, 16, 'the last observation for a probe wins');
});

// slice 10 -- one signal's contribution is a published function of its detail
// grade and its catalog weight. Nothing else.
test('core/score: a signal contributes weight for full, half for coarse, zero otherwise', () => {
  const webgl = core.getProbe('webgl');
  assert.equal(webgl.weight, 12);

  assert.equal(core.scoreSignal({ id: 'webgl', detail: 'full', status: 'ok' }).points, 12);
  assert.equal(core.scoreSignal({ id: 'webgl', detail: 'coarse', status: 'ok' }).points, 6);
  assert.equal(core.scoreSignal({ id: 'webgl', detail: 'none', status: 'unsupported' }).points, 0);
  assert.equal(core.scoreSignal({ id: 'webgl', detail: 'none', status: 'denied' }).points, 0);
  assert.equal(
    core.scoreSignal({ id: 'webgl', detail: 'full', status: 'denied' }).points,
    0,
    'only an ok status can contribute',
  );

  // odd weight -> coarse credit rounds up, and is never more than the weight
  const cores = core.scoreSignal({ id: 'cores', detail: 'coarse', status: 'ok' });
  assert.equal(core.getProbe('cores').weight, 6);
  assert.equal(cores.points, 3);
  const languages = core.scoreSignal({ id: 'languages', detail: 'coarse', status: 'ok' });
  assert.equal(core.getProbe('languages').weight, 7);
  assert.equal(languages.points, 4, 'ceil(7/2)');

  const contribution = core.scoreSignal({ id: 'ua', detail: 'full', status: 'ok' });
  assert.deepEqual(contribution, {
    id: 'ua',
    label: 'User agent & platform string',
    category: 'platform',
    status: 'ok',
    detail: 'full',
    weight: 10,
    points: 10,
    reason: 'full detail: 10 of 10 weight',
  });
});

// slice 11 -- category caps stop any one family of probes from dominating.
test('core/score: category totals are capped and the overflow is reported', () => {
  // rendering weights are canvas 12 + webgl 12 + fonts 8 = 32, capped at 26
  const snapshot = core.normalizeSnapshot([
    { id: 'canvas', value: { digest: 'a1b2c3d4e5f6' } },
    { id: 'webgl', value: { renderer: 'Intel Iris Plus Graphics 640' } },
    { id: 'fonts', value: ['Georgia', 'Menlo', 'Segoe UI'] },
  ]);

  const result = core.scoreSnapshot(snapshot);
  const rendering = result.categories.find((c) => c.id === 'rendering');

  assert.equal(rendering.rawPoints, 32, 'uncapped sum of contributing weights');
  assert.equal(rendering.cap, 26);
  assert.equal(rendering.points, 26, 'capped points');
  assert.equal(rendering.capped, true);
  assert.equal(rendering.label, 'Rendering surfaces');
  assert.deepEqual(
    rendering.contributions.map((c) => c.id),
    ['canvas', 'webgl', 'fonts'],
    'contributions stay in catalog order',
  );

  const storage = result.categories.find((c) => c.id === 'storage');
  assert.equal(storage.points, 0);
  assert.equal(storage.capped, false);

  assert.deepEqual(
    result.categories.map((c) => c.id),
    Object.keys(core.CATEGORIES),
    'every category is always reported, in declaration order',
  );
  assert.equal(result.total, 26, 'total is the sum of capped category points');
});

// slice 12 -- the headline figure is a bounded, reproducible breadth measure
// derived only from the caps, with no entropy or uniqueness claim.
test('core/score: reports a bounded percentage and a named band, purely', () => {
  const capSum = Object.values(core.CATEGORIES).reduce((sum, c) => sum + c.cap, 0);

  const empty = core.scoreSnapshot(core.normalizeSnapshot([]));
  assert.equal(empty.maxTotal, capSum, 'maxTotal is the sum of category caps');
  assert.equal(empty.total, 0);
  assert.equal(empty.percent, 0);
  assert.equal(empty.band.id, 'narrow');
  assert.equal(typeof empty.band.label, 'string');
  assert.ok(empty.band.summary.length > 20, 'the band carries an explanation');
  assert.equal(empty.formula, core.SCORE_FORMULA);

  const everything = core.normalizeSnapshot(
    core.PROBE_CATALOG.map((probe) => ({ id: probe.id, status: 'ok', detail: 'full', value: 1 })),
  );
  // force every signal to a full-detail ok state, as a scoring-only fixture
  const forced = {
    ...everything,
    signals: everything.signals.map((s) => ({ ...s, status: 'ok', detail: 'full' })),
  };
  const maxed = core.scoreSnapshot(forced);
  assert.equal(maxed.total, capSum);
  assert.equal(maxed.percent, 100);
  assert.equal(maxed.band.id, 'broad');

  // purity: repeated calls agree, and the input is untouched
  const before = JSON.stringify(forced);
  assert.deepEqual(core.scoreSnapshot(forced), maxed);
  assert.notEqual(core.scoreSnapshot(forced), maxed, 'a fresh object is returned each call');
  assert.equal(JSON.stringify(forced), before, 'scoring must not mutate the snapshot');

  for (const band of core.SCORE_BANDS) {
    assert.ok(Number.isInteger(band.minPercent), `${band.id} needs an integer threshold`);
  }
  assert.equal(core.SCORE_BANDS[0].minPercent, 0, 'bands must cover 0%');
});

// slice 13 -- exported JSON must be byte-identical for equal data regardless of
// key insertion order, so a report can be diffed or checksummed locally.
test('core/serialize: stable key ordering makes output byte-identical', () => {
  const a = { b: 1, a: { d: [3, 2], c: true } };
  const b = { a: { c: true, d: [3, 2] }, b: 1 };
  assert.equal(core.stableStringify(a), core.stableStringify(b));
  assert.equal(core.stableStringify(a), '{"a":{"c":true,"d":[3,2]},"b":1}');
  assert.equal(core.stableStringify([1, 'two', null]), '[1,"two",null]');
  assert.equal(core.stableStringify(undefined), 'null');
  assert.equal(core.stableStringify({ x: undefined, y: 1 }), '{"y":1}');
  assert.equal(core.stableStringify(Number.NaN), 'null', 'non-finite numbers become null');
  assert.equal(core.stableStringify({ n: 1 }, 2), '{\n  "n": 1\n}');
});

// slice 14 -- the export omits raw observed values unless the reader explicitly
// opts in. This is the single most important safety property of the export.
test('core/report: omits raw values by default, deeply', () => {
  const marker = 'MARKER-cf91a2';
  const snapshot = core.normalizeSnapshot(
    [
      { id: 'ua', value: { userAgent: `Mozilla/5.0 ${marker}`, platform: 'Linux' } },
      { id: 'languages', value: [`en-${marker}`, 'cy'] },
      { id: 'cores', value: 8 },
      { id: 'webgl', status: 'denied', reason: `blocked ${marker}` },
    ],
    { createdAt: '2026-03-04T05:06:07.000Z' },
  );

  const report = core.buildReport(snapshot);
  const json = core.stableStringify(report);

  assert.equal(report.app, 'GLASSHOUSE');
  assert.equal(report.reportVersion, core.REPORT_VERSION);
  assert.equal(report.createdAt, '2026-03-04T05:06:07.000Z');
  assert.equal(report.includesRawValues, false);
  assert.ok(
    !json.includes(marker),
    'no observed value, display string or reason may survive redaction',
  );

  const ua = report.signals.find((s) => s.id === 'ua');
  assert.equal(ua.valueOmitted, true);
  assert.ok(!('value' in ua), 'the value key itself is removed, not blanked');
  assert.ok(!('display' in ua), 'the rendered display string is removed too');
  assert.equal(ua.status, 'ok', 'status survives redaction');
  assert.equal(ua.detail, 'full', 'detail grade survives redaction');
  assert.equal(ua.points, 10, 'the audit trail survives redaction');
  assert.equal(ua.category, 'platform');

  assert.equal(report.score.total, core.scoreSnapshot(snapshot).total);
  assert.equal(report.score.formula, core.SCORE_FORMULA);
});

// slice 15 -- opting in is explicit and total: values come back, the flag says
// so, and the snapshot is never mutated by either path.
test('core/report: includes raw values only on explicit opt-in', () => {
  const snapshot = core.normalizeSnapshot(
    [
      { id: 'ua', value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } },
      { id: 'languages', value: ['en-GB', 'cy'] },
      { id: 'storage', status: 'denied', reason: 'blocked by policy' },
    ],
    { createdAt: '2026-03-04T05:06:07.000Z' },
  );
  const before = core.stableStringify(snapshot);

  const open = core.buildReport(snapshot, { includeRawValues: true });
  assert.equal(open.includesRawValues, true);
  const ua = open.signals.find((s) => s.id === 'ua');
  assert.equal(ua.value.userAgent, 'Mozilla/5.0 (X11; Linux x86_64)');
  assert.equal(ua.valueOmitted, undefined);
  assert.deepEqual(open.signals.find((s) => s.id === 'languages').value, ['en-GB', 'cy']);
  assert.equal(open.signals.find((s) => s.id === 'storage').reason, 'blocked by policy');

  // truthy-but-not-true must not be treated as consent
  for (const sneaky of ['true', 1, {}, 'yes']) {
    assert.equal(
      core.buildReport(snapshot, { includeRawValues: sneaky }).includesRawValues,
      false,
      `only boolean true opts in, got ${JSON.stringify(sneaky)}`,
    );
  }

  // redacting an already-open report is idempotent and lossless for the audit trail
  const closed = core.redactReport(open);
  assert.equal(closed.includesRawValues, false);
  assert.ok(!core.stableStringify(closed).includes('Mozilla'));
  assert.deepEqual(core.redactReport(closed), closed);
  assert.equal(open.signals.find((s) => s.id === 'ua').value.userAgent, ua.value.userAgent);

  assert.equal(core.stableStringify(snapshot), before, 'building a report must not mutate input');
  assert.equal(
    core.stableStringify(core.buildReport(snapshot)),
    core.stableStringify(core.buildReport(snapshot)),
    'the export is byte-reproducible',
  );

  // a redacted export must say the omission was deliberate
  const shut = core.buildReport(snapshot);
  assert.equal(typeof shut.redaction, 'object', 'a redacted report explains the omission');
  assert.equal(shut.redaction.applied, true);
  assert.deepEqual(shut.redaction.removedKeys, ['value', 'display', 'reason']);
  assert.ok(
    shut.redaction.note.includes('deliberately'),
    'the note states the omission is deliberate',
  );
  assert.equal(open.redaction.applied, false);
  assert.deepEqual(open.redaction.removedKeys, []);
});

// slice 16 -- comparing the previous local snapshot with the current one is how
// a reader sees which signals are stable enough to re-recognise them.
test('core/compare: classifies value, status, added and removed changes', () => {
  const previous = core.normalizeSnapshot(
    [
      { id: 'cores', value: 8 },
      { id: 'languages', value: ['en-GB'] },
      { id: 'timezone', value: { timeZone: 'Europe/London' } },
      { id: 'canvas', value: { digest: 'a1b2c3d4e5f6' } },
    ],
    { createdAt: '2026-01-01T00:00:00.000Z' },
  );
  const current = core.normalizeSnapshot(
    [
      { id: 'cores', value: 8 },
      { id: 'languages', value: ['en-GB', 'cy'] },
      { id: 'timezone', status: 'denied', reason: 'blocked' },
      { id: 'memory', value: 8 },
    ],
    { createdAt: '2026-01-02T00:00:00.000Z' },
  );

  const diff = core.compareSnapshots(previous, current);

  assert.equal(diff.previousCreatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(diff.currentCreatedAt, '2026-01-02T00:00:00.000Z');

  const byId = Object.fromEntries(diff.changes.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['canvas', 'languages', 'memory', 'timezone']);

  assert.equal(byId.languages.kind, 'value');
  assert.equal(byId.languages.before, 'en-GB');
  assert.equal(byId.languages.after, 'en-GB, cy');

  assert.equal(byId.timezone.kind, 'status', 'ok -> denied is a status change');
  assert.equal(byId.memory.kind, 'appeared', 'a probe that now reports is "appeared"');
  assert.equal(byId.canvas.kind, 'disappeared');

  assert.deepEqual(diff.stable, ['cores'], 'unchanged ok signals are listed as stable');
  assert.equal(diff.changedCount, 4);
  assert.deepEqual(
    diff.changes.map((c) => c.id),
    core.PROBE_CATALOG.map((p) => p.id).filter((id) => id in byId),
    'changes follow catalog order',
  );

  const same = core.compareSnapshots(previous, previous);
  assert.equal(same.changedCount, 0);
  assert.deepEqual(same.changes, []);
  assert.equal(core.compareSnapshots(null, current), null, 'no previous snapshot -> no comparison');
});

// slice 17 -- core.mjs must stay a pure data module: no browser globals, no
// I/O, no clock, no randomness, so every result is reproducible from its input.
test('core/purity: core.mjs references no browser global, clock or randomness', async () => {
  const source = await readFile(new URL('./core.mjs', import.meta.url), 'utf8');
  const forbidden = [
    'window',
    'document',
    'navigator',
    'localStorage',
    'sessionStorage',
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'Date.now',
    'new Date',
    'Math.random',
    'performance.now',
    'process.',
    'require(',
    'import(',
  ];
  // strip comments and string literals so probe prose cannot trip the scan
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');

  for (const token of forbidden) {
    assert.ok(!code.includes(token), `core.mjs must not reference ${token}`);
  }
  assert.ok(!/\bimport\s+/.test(code), 'core.mjs must have no imports at all');
  assert.equal(
    core.STORAGE_KEYS.snapshot.startsWith('glasshouse.'),
    true,
    'storage keys are declared as data only',
  );
});

// slice 18 -- the document shell: mobile-first, self-contained, offline.
test('html/shell: is a self-contained offline document that imports core.mjs', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

  assert.match(html, /^<!doctype html>/i, 'needs a doctype');
  assert.match(html, /<html[^>]*\slang="en"/i, 'needs a language');
  assert.match(html, /<title>[^<]*GLASSHOUSE[^<]*<\/title>/i);
  assert.match(html, /<meta\s+name="viewport"\s+content="[^"]*width=device-width/i);
  assert.match(html, /<meta\s+name="color-scheme"/i);
  assert.match(html, /<meta\s+name="description"/i);
  assert.match(html, /<script\s+type="module">/i, 'the page script is an inline module');
  assert.match(html, /from\s+'\.\/core\.mjs'/, 'the page must import the tested core');
  assert.match(html, /<canvas\b/i, 'the cinematic backdrop is a canvas');
  assert.match(html, /prefers-reduced-motion/i, 'motion must respect the user preference');

  // no external resources of any kind
  assert.ok(!/https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no absolute URLs');
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'no external stylesheet');
  assert.ok(!/@import/i.test(html), 'no CSS @import');
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external script');
  assert.ok(!/<(img|iframe|video|audio|source|embed|object)\b/i.test(html), 'no external media');

  // no runtime networking of any kind
  for (const api of [
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'importScripts',
    'serviceWorker',
    'RTCPeerConnection',
  ]) {
    assert.ok(!html.includes(api), `page must not reference ${api}`);
  }
});

// slice 19 -- the page must collect every catalog probe and must delegate all
// deterministic logic to core.mjs rather than reimplementing any of it.
test('html/probes: collects every catalog probe and reuses core, never reimplements it', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const script = html.slice(html.indexOf('<script type="module">'));

  for (const probe of core.PROBE_CATALOG) {
    assert.match(
      script,
      new RegExp(`\\b${probe.id}\\s*:\\s*\\(`),
      `page needs a collector for probe "${probe.id}"`,
    );
  }

  // the tested functions must actually be used
  for (const fn of ['normalizeSnapshot', 'scoreSnapshot', 'compareSnapshots']) {
    assert.ok(script.includes(`core.${fn}(`), `page must call core.${fn}()`);
  }

  // and must not be duplicated in the page
  for (const forbidden of [
    'function scoreSnapshot',
    'function scoreSignal',
    'function redactReport',
    'function compareSnapshots',
    'function normalizeSignal',
    'DETAIL_FACTORS =',
    'valueOmitted:',
  ]) {
    assert.ok(!script.includes(forbidden), `page must not reimplement ${forbidden}`);
  }

  // no probe may ask for a permission or a high-entropy hint
  for (const invasive of [
    'requestPermission',
    'permissions.query',
    'getUserMedia',
    'geolocation',
    'getHighEntropyValues',
    'requestMIDIAccess',
    'getBattery',
    'AudioContext',
    'credentials',
    'clipboard',
  ]) {
    assert.ok(!script.includes(invasive), `page must not use ${invasive}`);
  }

  assert.match(script, /getEntropy|createSnapshot|runProbes|collectAll/, 'needs a run entry point');
});

// slice 20 -- controls and accessibility: keyboard-operable semantic controls,
// a live status region, per-signal guidance, and a redaction-aware export.
test('html/controls: exposes accessible controls, guidance and a local export', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const script = html.slice(html.indexOf('<script type="module">'));

  // real controls, not clickable divs
  for (const id of ['rerun', 'export-report', 'reset-data', 'include-raw']) {
    assert.ok(html.includes(`id="${id}"`), `missing control #${id}`);
  }
  assert.match(html, /<button\b[^>]*id="rerun"/i, 'rerun must be a button');
  assert.match(html, /<button\b[^>]*id="export-report"/i, 'export must be a button');
  assert.match(html, /<button\b[^>]*id="reset-data"/i, 'reset must be a button');
  assert.match(html, /<input\b[^>]*type="checkbox"[^>]*id="include-raw"/i);
  assert.match(html, /<label\b[^>]*for="include-raw"/i, 'the opt-in needs a real label');
  assert.ok(!/onclick=/i.test(html), 'no inline event handlers');
  assert.ok(!/<div[^>]*role="button"/i.test(html), 'no faux buttons');

  // live status and progress
  assert.match(html, /aria-live="polite"/i, 'status updates must be announced');
  assert.match(html, /role="status"/i);
  assert.match(html, /<progress\b/i, 'staged reveal needs visible progress');

  // per-signal explanation and mitigation come from the catalog
  assert.ok(script.includes('probe.explanation'), 'each signal must show its explanation');
  assert.ok(script.includes('probe.mitigation'), 'each signal must show mitigation guidance');
  assert.match(html, /<details|<dl\b/i, 'guidance needs a real disclosure/description element');

  // export path goes through the tested, redaction-aware core
  assert.ok(script.includes('core.buildReport('), 'export must use core.buildReport');
  assert.ok(script.includes('core.stableStringify('), 'export must be deterministic');
  assert.ok(script.includes('createObjectURL'), 'export is a local file download');
  assert.ok(!script.includes('mailto:'), 'export must not offer to send anything');

  // reset must clear exactly the disclosed keys
  for (const key of Object.values(core.STORAGE_KEYS)) {
    assert.ok(html.includes(key), `the page must disclose the storage key ${key}`);
  }
  assert.ok(script.includes('removeItem'), 'reset must delete local data');
  assert.ok(script.includes('let storageGeneration = 0'), 'storage writes need a cancellation generation');
  const scanBody = script.slice(script.indexOf('async function runProbes()'), script.indexOf('function exportReport()'));
  assert.ok(
    scanBody.includes('const runStorageGeneration = storageGeneration') &&
      scanBody.includes('if (runStorageGeneration === storageGeneration) writePrevious(state.snapshot)'),
    'a scan started before deletion must not recreate the deleted snapshot',
  );
  const resetBody = script.slice(script.indexOf('function resetLocalData()'), script.indexOf('/* mirror match: begin'));
  assert.ok(
    resetBody.includes('storageGeneration += 1'),
    'deleting local data must invalidate storage writes from scans still in flight',
  );

  // headings must be ordered and unique-rooted
  assert.equal((html.match(/<h1\b/g) || []).length, 1, 'exactly one h1');
  assert.ok((html.match(/<h2\b/g) || []).length >= 4, 'sections use h2');

  // canvas motion must be switchable off, not merely slowed
  assert.ok(
    script.includes('cancelAnimationFrame'),
    'reduced motion must stop the animation loop outright',
  );
});

// slice 21 -- the reveal must be genuinely staged: each signal card appears
// during collection, rather than all cards arriving only after every probe ends.
test('html/reveal: renders each signal during the staged probe loop', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const script = html.slice(html.indexOf('<script type="module">'));
  const runStart = script.indexOf('async function runProbes()');
  const runEnd = script.indexOf('function exportReport()', runStart);
  const runner = script.slice(runStart, runEnd);
  const reveal = runner.indexOf('els.signalsList.append(signalCard(');
  const finalize = runner.indexOf('state.snapshot = core.normalizeSnapshot(');

  assert.notEqual(reveal, -1, 'the runner must append a signal card');
  assert.ok(reveal < finalize, 'a card must appear before the completed snapshot is finalized');
  assert.equal(
    (runner.match(/els\.signalsList\.append\(signalCard\(/g) || []).length,
    1,
    'each probe must be rendered once, not duplicated during finalization',
  );
});

// slice 22 -- the inline module is real code with no build step, so the
// verifier must parse it rather than trust it.
test('html/syntax: the inline module parses as an ES module', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const open = '<script type="module">';
  const start = html.indexOf(open);
  assert.notEqual(start, -1, 'no inline module found');
  const end = html.indexOf('</script>', start);
  assert.notEqual(end, -1, 'inline module is unterminated');

  const source = html.slice(start + open.length, end);
  assert.ok(source.trim().length > 500, 'inline module looks suspiciously small');
  assert.equal(
    html.indexOf(open, start + 1),
    -1,
    'exactly one inline module, so nothing escapes this check',
  );

  const temp = join(tmpdir(), `glasshouse-inline-${process.pid}.mjs`);
  try {
    await writeFile(temp, source, 'utf8');
    execFileSync(process.execPath, ['--check', temp], { stdio: 'pipe' });
  } finally {
    await rm(temp, { force: true });
  }
});

// slice 22 -- the README must document what actually ships, and its numbers
// must be derived from the same catalog the code uses.
test('readme/docs: documents every probe, weight, cap and boundary truthfully', async () => {
  const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');

  for (const heading of [
    'Threat model',
    'Limitations',
    'Probes',
    'Exposure score',
    'Controls',
    'Privacy boundary',
    'Stored data',
    'Report',
    'Local preview',
    'Verification',
  ]) {
    assert.ok(
      new RegExp(`^#{2,3}\\s.*${heading}`, 'im').test(readme),
      `README needs a "${heading}" section`,
    );
  }

  // every probe documented, with its real weight and category
  for (const probe of core.PROBE_CATALOG) {
    assert.ok(readme.includes(`\`${probe.id}\``), `README must document probe ${probe.id}`);
    assert.ok(
      new RegExp(`\`${probe.id}\`[^\\n]*\\b${probe.weight}\\b`).test(readme),
      `README must state weight ${probe.weight} for ${probe.id}`,
    );
  }
  assert.ok(
    readme.includes(`${core.PROBE_CATALOG.length} probes`),
    `README must state the probe count (${core.PROBE_CATALOG.length})`,
  );

  // every category and its cap
  for (const [id, category] of Object.entries(core.CATEGORIES)) {
    assert.ok(readme.includes(`\`${id}\``), `README must document category ${id}`);
    assert.ok(
      new RegExp(`\`${id}\`[^\\n]*\\b${category.cap}\\b`).test(readme),
      `README must state cap ${category.cap} for category ${id}`,
    );
  }

  // the score envelope must match the code exactly
  assert.ok(readme.includes(String(core.MAX_TOTAL)), 'README must state the maximum total');
  for (const band of core.SCORE_BANDS) {
    assert.ok(readme.includes(band.label), `README must list band "${band.label}"`);
  }
  assert.ok(readme.includes('ceil'), 'README must state the rounding rule');
  assert.ok(readme.includes('0.5'), 'README must state the coarse factor');

  // storage keys and the deployment URL
  for (const key of Object.values(core.STORAGE_KEYS)) {
    assert.ok(readme.includes(key), `README must disclose ${key}`);
  }
  assert.ok(
    readme.includes('https://aichrisz.github.io/glasshouse/'),
    'README must state the expected Pages URL',
  );
  assert.ok(readme.includes('node verify.mjs'), 'README must document how to verify');

  // and it must not overclaim
  for (const claim of [
    'entropy bits',
    'bits of entropy',
    'uniqueness probability',
    'you are unique',
    'anonymous',
    'guarantee',
    '100% private',
  ]) {
    assert.ok(
      !new RegExp(claim, 'i').test(readme),
      `README must not claim "${claim}" without evidence`,
    );
  }
});

// slice 23 -- a repository-wide sweep: no stray networking, no secrets, no
// absolute host paths, no debug residue, no unexpected files.
test('repo/hygiene: ships only the intended files, with no residue', async () => {
  const root = new URL('./', import.meta.url);
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(entries, ['README.md', 'TDD_EVIDENCE.md', 'core.mjs', 'index.html', 'verify.mjs']);

  const shipped = ['index.html', 'core.mjs'];
  for (const name of shipped) {
    const text = await readFile(new URL(`./${name}`, root), 'utf8');

    assert.ok(!/https?:\/\//i.test(text), `${name} must contain no absolute URL`);
    assert.ok(!/\/(?:home|root|Users)\//.test(text), `${name} must contain no absolute host path`);
    assert.ok(!/console\.(log|debug|warn|error)\(/.test(text), `${name} has debug residue`);
    assert.ok(!/\bTODO\b|\bFIXME\b|\bXXX\b/.test(text), `${name} has an unresolved marker`);
    assert.ok(!/debugger/.test(text), `${name} has a debugger statement`);

    for (const secret of [
      'api_key',
      'apiKey',
      'secret',
      'password',
      'BEGIN RSA',
      'BEGIN PRIVATE KEY',
      'AKIA',
      'Bearer ',
    ]) {
      assert.ok(!text.includes(secret), `${name} must not contain "${secret}"`);
    }

    // tracker *usage*, not the word: the page is allowed to say "no analytics"
    for (const tracker of [
      'gtag(',
      'dataLayer',
      'analytics.',
      'googletagmanager',
      'Sentry.',
      'telemetry.',
      'ga(',
      '_paq',
    ]) {
      assert.ok(!text.includes(tracker), `${name} must not reference ${tracker}`);
    }
  }

  // the page never writes a storage key it has not disclosed
  const html = await readFile(new URL('./index.html', root), 'utf8');
  const writes = [...html.matchAll(/setItem\(\s*([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(writes.length > 0, 'expected at least one disclosed write');
  for (const target of writes) {
    assert.ok(
      target.startsWith('core.STORAGE_KEYS.'),
      `storage writes must use a disclosed key, found ${target}`,
    );
  }
});

// ---------------------------------------------------------------------------
// v1.1 MIRROR MATCH -- importing two previously exported reports and comparing
// them locally. Fixtures are built through the tested export path, so a test
// can never assert against a report shape the app does not actually produce.
// ---------------------------------------------------------------------------

const RAW_A = [
  {
    id: 'screen',
    value: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1050,
      colorDepth: 24,
      pixelDepth: 24,
      orientation: 'landscape-primary',
    },
  },
  {
    id: 'viewport',
    value: {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      outerWidth: 1280,
      outerHeight: 800,
    },
  },
  {
    id: 'timezone',
    value: {
      timeZone: 'Europe/London',
      utcOffsetMinutes: 60,
      locale: 'en-GB',
      calendar: 'gregory',
      numberingSystem: 'latn',
    },
  },
  { id: 'languages', value: ['en-GB', 'en'] },
  {
    id: 'ua',
    value: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      platform: 'Linux x86_64',
      vendor: 'Acme',
      engineHint: 'Gecko',
    },
  },
  { id: 'clientHints', value: { brands: ['Chromium'], mobile: false, platform: 'Linux' } },
  { id: 'touch', value: { maxTouchPoints: 0, pointer: 'fine', anyHover: true, pointerEvents: true } },
  { id: 'cores', value: 8 },
  { id: 'memory', value: 8 },
  {
    id: 'canvas',
    value: { digest: 'a1b2c3d4e5f6a7b8', textDigest: '9f8e7d6c', pixelSample: '0f1e2d', dataLength: 4096 },
  },
  {
    id: 'webgl',
    value: {
      vendor: 'Intel Inc.',
      renderer: 'Intel Iris Plus Graphics 640',
      version: 'WebGL 1.0',
      shadingLanguage: 'GLSL ES 1.0',
      maxTextureSize: 16384,
      extensionCount: 32,
    },
  },
  { id: 'fonts', value: ['Arial', 'Georgia', 'Menlo'] },
  {
    id: 'prefs',
    value: {
      prefersReducedMotion: false,
      colorScheme: 'dark',
      contrast: 'no-preference',
      forcedColors: false,
      prefersReducedTransparency: false,
    },
  },
  {
    id: 'storage',
    value: {
      cookiesEnabled: true,
      localStorage: true,
      sessionStorage: true,
      indexedDB: true,
      storageManager: true,
    },
  },
];

/** Side B: same machine, more masking. webgl masked, canvas denied, extra language. */
const RAW_B = RAW_A.filter((entry) => !['webgl', 'canvas', 'languages'].includes(entry.id)).concat([
  { id: 'languages', value: ['en-GB', 'en', 'cy'] },
  { id: 'canvas', status: 'denied', reason: 'canvas readback blocked' },
  {
    id: 'webgl',
    value: {
      vendor: 'Mozilla',
      renderer: 'llvmpipe (LLVM 15.0.7)',
      version: 'WebGL 1.0',
      shadingLanguage: 'GLSL ES 1.0',
      maxTextureSize: 16384,
      extensionCount: 30,
    },
  },
]);

const reportText = (raw, createdAt, includeRawValues) =>
  core.stableStringify(
    core.buildReport(core.normalizeSnapshot(raw, { createdAt }), { includeRawValues }),
    2,
  );

const importOrThrow = (text) => {
  const result = core.parseReportText(text);
  if (!result.ok) {
    throw new Error(`unexpected rejection: ${result.errors.map((e) => e.code).join(',')}`);
  }
  return result.report;
};

// slice 25 -- an imported report is untrusted input. Before anything reaches
// the screen it must be bounded, parseable and recognisably a GLASSHOUSE report.
test('core/import: rejects unbounded, malformed, non-object and foreign report text', () => {
  assert.equal(typeof core.parseReportText, 'function', 'parseReportText must be a function');
  assert.ok(core.REPORT_IMPORT_LIMITS, 'REPORT_IMPORT_LIMITS must be declared');
  assert.equal(
    core.REPORT_IMPORT_LIMITS.maxBytes,
    262144,
    'the documented conservative bound is 256 KiB',
  );

  const reject = (text, code) => {
    const result = core.parseReportText(text);
    const codes = result.errors.map((e) => e.code);
    assert.equal(result.ok, false, `expected rejection, got ok for ${String(text).slice(0, 20)}`);
    assert.equal(result.report, null, 'a rejected import must yield no report at all');
    assert.ok(result.errors.length > 0, 'a rejection must explain itself');
    for (const error of result.errors) {
      assert.equal(typeof error.code, 'string', 'each error needs a stable code');
      assert.ok(error.message.length >= 12, `error ${error.code} needs a readable message`);
    }
    assert.ok(codes.includes(code), `expected code "${code}", got "${codes.join(',')}"`);
  };

  reject(123, 'not-text');
  reject('', 'empty');
  reject('   \n\t ', 'empty');
  reject('{not json', 'malformed-json');
  reject('[]', 'not-object');
  reject('null', 'not-object');
  reject('"a string"', 'not-object');
  reject('42', 'not-object');
  reject(JSON.stringify({ app: 'SOMETHING ELSE', reportVersion: 1 }), 'foreign-report');
  reject(JSON.stringify({ app: 'GLASSHOUSE' }), 'unsupported-version');
  reject(JSON.stringify({ app: 'GLASSHOUSE', reportVersion: 99 }), 'unsupported-version');
  reject(JSON.stringify({ app: 'GLASSHOUSE', reportVersion: '1' }), 'unsupported-version');
  const deeplyNestedVersion =
    '{"app":"GLASSHOUSE","reportVersion":' + '['.repeat(5000) + '0' + ']'.repeat(5000) + '}';
  assert.doesNotThrow(
    () => reject(deeplyNestedVersion, 'unsupported-version'),
    'bounded adversarial JSON must fail closed instead of overflowing the rejection path',
  );

  // the bound is measured in UTF-8 bytes, not in characters
  assert.equal(core.utf8ByteLength('abc'), 3);
  assert.equal(core.utf8ByteLength('\u00e9'), 2);
  assert.equal(core.utf8ByteLength('\u20ac'), 3);
  assert.equal(core.utf8ByteLength('\u{1f600}'), 4);
  reject(`{"pad":"${'x'.repeat(core.REPORT_IMPORT_LIMITS.maxBytes)}"}`, 'too-large');

  // an oversized file is refused without being parsed at all
  const oversized = core.parseReportText('x'.repeat(core.REPORT_IMPORT_LIMITS.maxBytes + 1));
  assert.deepEqual(
    oversized.errors.map((e) => e.code),
    ['too-large'],
    'the size gate short-circuits before parsing',
  );
});

// slice 26 -- the signal list is the spine of a report. A comparison is only
// meaningful when both sides describe exactly the catalog, once each.
test('core/import: rejects missing, duplicated and unknown probe ids', () => {
  const valid = JSON.parse(reportText(RAW_A, '2026-05-01T00:00:00.000Z', false));

  const rejectMutated = (mutate, code) => {
    const candidate = JSON.parse(core.stableStringify(valid));
    mutate(candidate);
    const result = core.validateReport(candidate);
    const codes = result.errors.map((e) => e.code);
    assert.equal(result.ok, false, `expected rejection for ${code}`);
    assert.equal(result.report, null, 'rejection is atomic: no partial report');
    assert.ok(codes.includes(code), `expected "${code}", got "${codes.join(',')}"`);
    return result;
  };

  rejectMutated((r) => {
    delete r.signals;
  }, 'signals-missing');
  rejectMutated((r) => {
    r.signals = {};
  }, 'signals-missing');
  rejectMutated((r) => {
    r.signals = [];
  }, 'signals-missing');
  const amplified = rejectMutated((r) => {
    r.signals = Array.from({ length: 87335 }, () => ({}));
  }, 'signals-missing');
  assert.equal(amplified.errors.length, 1, 'wrong-sized signal lists must fail before per-entry validation');
  rejectMutated((r) => {
    const cores = r.signals.findIndex((s) => s.id === 'cores');
    r.signals[cores] = { ...r.signals[0] };
  }, 'missing-probe');
  rejectMutated((r) => {
    r.signals[r.signals.length - 1] = { ...r.signals[0] };
  }, 'duplicate-probe');
  rejectMutated((r) => {
    r.signals[r.signals.length - 1] = { ...r.signals[0], id: 'audioStack' };
  }, 'unknown-probe');
  rejectMutated((r) => {
    r.signals[3] = { ...r.signals[3], id: null };
  }, 'unknown-probe');
  rejectMutated((r) => {
    r.signals[2] = 'not a signal';
  }, 'unknown-probe');

  // the named probe appears in the message, so the reader knows which one
  const missing = rejectMutated((r) => {
    const webgl = r.signals.findIndex((s) => s.id === 'webgl');
    r.signals[webgl] = { ...r.signals[0] };
  }, 'missing-probe');
  assert.ok(
    missing.errors.some((e) => e.message.includes('webgl')),
    'the message must name the missing probe',
  );

  // every error is reported at once rather than one per attempt
  const several = core.validateReport({
    ...valid,
    signals: [...valid.signals.filter((s) => s.id !== 'cores'), { ...valid.signals[0], id: 'ghost' }],
  });
  const codes = several.errors.map((e) => e.code);
  assert.ok(codes.includes('missing-probe') && codes.includes('unknown-probe'), codes.join(','));
});

// slice 27 -- a report's arithmetic must be re-derivable from its own audit
// trail. If the declared points or totals disagree with the published formula,
// the file is not a GLASSHOUSE report and must not be shown as one.
test('core/import: rejects invalid grades and score arithmetic it cannot re-derive', () => {
  const valid = JSON.parse(reportText(RAW_A, '2026-05-01T00:00:00.000Z', false));
  const at = (report, id) => report.signals.find((s) => s.id === id);

  const rejectMutated = (mutate, code) => {
    const candidate = JSON.parse(core.stableStringify(valid));
    mutate(candidate);
    const result = core.validateReport(candidate);
    const codes = result.errors.map((e) => e.code);
    assert.equal(result.ok, false, `expected rejection for ${code}`);
    assert.equal(result.report, null, 'rejection is atomic: no partial report');
    assert.ok(codes.includes(code), `expected "${code}", got "${codes.join(',')}"`);
  };

  // statuses and detail grades must come from the published enumerations
  rejectMutated((r) => {
    at(r, 'cores').status = 'maybe';
  }, 'invalid-status');
  rejectMutated((r) => {
    at(r, 'cores').status = null;
  }, 'invalid-status');
  rejectMutated((r) => {
    at(r, 'cores').detail = 'partial';
  }, 'invalid-detail');
  rejectMutated((r) => {
    // a probe that never returned a reading cannot carry a detail grade
    const signal = at(r, 'memory');
    signal.status = 'unsupported';
    signal.points = 0;
  }, 'invalid-detail');
  rejectMutated((r) => {
    at(r, 'cores').detail = 'none';
  }, 'invalid-detail'); // an ok reading is always full or coarse

  // weights are catalog facts, not file contents
  rejectMutated((r) => {
    at(r, 'webgl').weight = 40;
  }, 'invalid-weight');
  rejectMutated((r) => {
    at(r, 'webgl').weight = '12';
  }, 'invalid-weight');

  // points must equal the published function of status and detail
  rejectMutated((r) => {
    at(r, 'cores').points = 6.5;
  }, 'invalid-points');
  rejectMutated((r) => {
    at(r, 'memory').points = 0;
  }, 'invalid-points');
  rejectMutated((r) => {
    at(r, 'ua').points = 9;
  }, 'invalid-points');

  // the score block must exist and must agree with the signals
  rejectMutated((r) => {
    delete r.score;
  }, 'score-missing');
  rejectMutated((r) => {
    r.score.categories = 'nope';
  }, 'score-missing');
  rejectMutated((r) => {
    r.score.maxTotal = 100;
  }, 'score-bounds');
  rejectMutated((r) => {
    r.score.total = core.MAX_TOTAL + 1;
  }, 'score-bounds');
  rejectMutated((r) => {
    r.score.total = -1;
  }, 'score-bounds');
  rejectMutated((r) => {
    r.score.total = valid.score.total - 1;
  }, 'score-inconsistent');
  rejectMutated((r) => {
    r.score.percent = 3;
  }, 'score-inconsistent');
  rejectMutated((r) => {
    r.score.band = { id: 'narrow', label: 'Narrow surface' };
  }, 'score-inconsistent');
  rejectMutated((r) => {
    delete r.score.band;
  }, 'score-inconsistent');
  rejectMutated((r) => {
    r.score.categories = r.score.categories.filter((c) => c.id !== 'rendering');
  }, 'category-inconsistent');
  rejectMutated((r) => {
    r.score.categories.push({ ...r.score.categories[0] });
  }, 'category-inconsistent');
  rejectMutated((r) => {
    r.score.categories.push({ id: 'invented', label: 'Invented', cap: 0, points: 0 });
  }, 'category-inconsistent');
  rejectMutated((r) => {
    r.score.categories.find((c) => c.id === 'rendering').cap = 99;
  }, 'category-inconsistent');
  rejectMutated((r) => {
    r.score.categories.find((c) => c.id === 'locale').points = 0;
  }, 'category-inconsistent');

  // a category cap that genuinely bit is not an inconsistency
  const capped = core.validateReport(valid);
  assert.equal(capped.ok, true, capped.errors.map((e) => e.message).join(' | '));
  assert.equal(
    valid.score.categories.find((c) => c.id === 'rendering').points,
    core.CATEGORIES.rendering.cap,
    'the fixture must actually exercise a capped category',
  );
});

// slice 28 -- a default (redacted) export must import cleanly and be fully
// useful, and the imported form must be re-derived from the catalog rather
// than echoed from the file.
test('core/import: accepts a redacted export and re-derives it from the catalog', () => {
  const text = reportText(RAW_A, '2026-05-01T00:00:00.000Z', false);
  const report = importOrThrow(text);

  assert.equal(report.app, 'GLASSHOUSE');
  assert.equal(report.reportVersion, core.REPORT_VERSION);
  assert.equal(report.snapshotVersion, core.SNAPSHOT_VERSION);
  assert.equal(report.createdAt, '2026-05-01T00:00:00.000Z');
  assert.equal(report.includesRawValues, false);
  assert.equal(report.redacted, true, 'a report without raw values is flagged as redacted');

  assert.equal(report.score.total, 88);
  assert.equal(report.score.maxTotal, core.MAX_TOTAL);
  assert.equal(report.score.percent, 100);
  assert.equal(report.score.band.id, 'broad');
  assert.deepEqual(
    report.score.categories.map((c) => c.id),
    Object.keys(core.CATEGORIES),
    'categories are present in declaration order for the delta table',
  );
  const rendering = report.score.categories.find((c) => c.id === 'rendering');
  assert.equal(rendering.cap, core.CATEGORIES.rendering.cap);
  assert.equal(rendering.points, core.CATEGORIES.rendering.cap);

  assert.deepEqual(
    report.signals.map((s) => s.id),
    core.PROBE_CATALOG.map((p) => p.id),
    'signals are re-ordered into catalog order, whatever the file said',
  );
  for (const signal of report.signals) {
    const probe = core.getProbe(signal.id);
    assert.equal(signal.label, probe.label, 'labels come from the catalog, not the file');
    assert.equal(signal.category, probe.category);
    assert.equal(signal.weight, probe.weight);
    assert.equal(signal.value, null, 'a redacted import carries no observed value');
    assert.equal(signal.display, null, 'a redacted import carries no rendered value');
    assert.equal(typeof signal.truncated, 'boolean');
  }

  // file order is irrelevant, and unrecognised top-level keys are not carried
  const shuffled = JSON.parse(text);
  shuffled.signals = [...shuffled.signals].reverse();
  shuffled.somethingElse = { injected: true };
  shuffled.signals[0] = { ...shuffled.signals[0], label: 'ATTACKER TEXT' };
  const frozen = core.stableStringify(shuffled);
  const second = importOrThrow(core.stableStringify(shuffled));
  assert.deepEqual(
    second.signals.map((s) => s.id),
    core.PROBE_CATALOG.map((p) => p.id),
  );
  assert.ok(
    !core.stableStringify(second).includes('ATTACKER TEXT'),
    'text from the file must not reach the imported report',
  );
  assert.ok(!('somethingElse' in second), 'unrecognised keys are dropped, not carried');
  assert.equal(core.stableStringify(shuffled), frozen, 'validation must not mutate its input');

  // the imported shape is closed: exactly these keys, so nothing sneaks through
  assert.deepEqual(Object.keys(report).sort(), [
    'createdAt',
    'includesRawValues',
    'app',
    'redacted',
    'reportVersion',
    'score',
    'signals',
    'snapshotVersion',
  ].sort());
});

// slice 29 -- exact values are the sensitive part of an import. They are read
// only when the file declares raw inclusion with a literal boolean and the
// values themselves still normalise to the grade the file claims.
test('core/import: reads raw values only behind a literal boolean flag', () => {
  const stamp = '2026-05-01T00:00:00.000Z';
  const openText = reportText(RAW_A, stamp, true);
  const open = importOrThrow(openText);

  assert.equal(open.includesRawValues, true);
  assert.equal(open.redacted, false);
  const ua = open.signals.find((s) => s.id === 'ua');
  assert.equal(ua.value.userAgent, 'Mozilla/5.0 (X11; Linux x86_64)');
  assert.ok(ua.display.includes('Mozilla/5.0'), 'an imported value gets a rendered display string');
  assert.deepEqual(open.signals.find((s) => s.id === 'languages').value, ['en-GB', 'en']);
  assert.equal(open.signals.find((s) => s.id === 'cores').value, 8);

  const openB = importOrThrow(reportText(RAW_B, stamp, true));
  const canvasB = openB.signals.find((s) => s.id === 'canvas');
  assert.equal(canvasB.status, 'denied');
  assert.equal(canvasB.value, null, 'a blocked probe has no value to import');
  assert.equal(canvasB.reason, 'canvas readback blocked');

  const rejectMutated = (base, mutate, code) => {
    const candidate = JSON.parse(base);
    mutate(candidate);
    const result = core.parseReportText(core.stableStringify(candidate));
    const codes = result.errors.map((e) => e.code);
    assert.equal(result.ok, false, `expected rejection for ${code}`);
    assert.equal(result.report, null, 'rejection is atomic: no partial report');
    assert.ok(codes.includes(code), `expected "${code}", got "${codes.join(',')}"`);
  };

  // a truthy string is never consent
  for (const sneaky of ['true', 1, 'yes', {}, [], null]) {
    rejectMutated(
      openText,
      (r) => {
        r.includesRawValues = sneaky;
      },
      'raw-flag-invalid',
    );
  }

  // claiming raw inclusion without supplying values is a contradiction
  rejectMutated(
    reportText(RAW_A, stamp, false),
    (r) => {
      r.includesRawValues = true;
    },
    'raw-values-missing',
  );

  // a value that no longer supports its own declared grade is rejected
  rejectMutated(
    openText,
    (r) => {
      r.signals.find((s) => s.id === 'webgl').value.renderer = 'llvmpipe (LLVM 15.0.7)';
    },
    'raw-values-invalid',
  );
  rejectMutated(
    openText,
    (r) => {
      r.signals.find((s) => s.id === 'cores').value = 'eight';
    },
    'raw-values-invalid',
  );
  const deeplyNestedRaw = JSON.parse(openText);
  let nestedValue = 'en';
  for (let depth = 0; depth < 20000; depth += 1) nestedValue = [nestedValue];
  deeplyNestedRaw.signals.find((s) => s.id === 'languages').value = nestedValue;
  assert.doesNotThrow(() => {
    const result = core.validateReport(deeplyNestedRaw);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'raw-values-invalid'));
  }, 'deeply nested raw values must be rejected without overflowing normalisation');
  // and a non-ok probe must not smuggle one in
  rejectMutated(
    reportText(RAW_B, stamp, true),
    (r) => {
      r.signals.find((s) => s.id === 'canvas').value = { digest: 'a1b2c3d4e5f6' };
    },
    'raw-values-invalid',
  );

  // the snapshot schema is part of the version contract
  rejectMutated(
    reportText(RAW_A, stamp, false),
    (r) => {
      r.snapshotVersion = 7;
    },
    'unsupported-version',
  );

  // imported values are re-normalised, so file contents stay bounded
  const dirty = JSON.parse(openText);
  dirty.signals.find((s) => s.id === 'ua').value.userAgent = 'x  y'.repeat(400);
  const cleaned = importOrThrow(core.stableStringify(dirty));
  assert.equal(
    cleaned.signals.find((s) => s.id === 'ua').value.userAgent.length,
    core.LIMITS.string,
    'an oversized file value is clamped by the same rule as a live reading',
  );

  // a file that declares redaction is treated as redacted even if it leaks
  const contradictory = JSON.parse(openText);
  contradictory.includesRawValues = false;
  contradictory.redaction = { applied: true, removedKeys: [], note: 'x' };
  const guarded = importOrThrow(core.stableStringify(contradictory));
  assert.equal(guarded.redacted, true);
  assert.ok(
    !core.stableStringify(guarded).includes('Mozilla'),
    'values a report says it omitted are never read',
  );
});

// slice 30 -- MIRROR MATCH proper: a default (redacted) report on each side is
// still fully useful. Totals, category deltas and per-signal exposure changes
// are all derivable without any observed value.
test('core/mirror: compares two redacted reports structurally', () => {
  const a = importOrThrow(reportText(RAW_A, '2026-05-01T00:00:00.000Z', false));
  const b = importOrThrow(reportText(RAW_B, '2026-05-02T00:00:00.000Z', false));
  const mirror = core.compareReports(a, b);

  assert.equal(mirror.comparisonVersion, core.COMPARISON_VERSION);
  assert.equal(mirror.a.createdAt, '2026-05-01T00:00:00.000Z');
  assert.equal(mirror.b.createdAt, '2026-05-02T00:00:00.000Z');
  assert.equal(mirror.a.redacted, true);
  assert.equal(mirror.b.redacted, true);

  // each side reports its own headline figures
  assert.equal(mirror.a.total, 88);
  assert.equal(mirror.a.percent, 100);
  assert.equal(mirror.a.band.label, 'Broad surface');
  assert.equal(mirror.b.total, 76);
  assert.equal(mirror.b.maxTotal, core.MAX_TOTAL);
  assert.equal(mirror.b.percent, 86);

  // and the delta runs from A to B
  assert.equal(mirror.totals.before, 88);
  assert.equal(mirror.totals.after, 76);
  assert.equal(mirror.totals.delta, -12);
  assert.equal(mirror.totals.percentDelta, -14);
  assert.equal(mirror.totals.bandChanged, false);

  const cats = Object.fromEntries(mirror.categories.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(cats), Object.keys(core.CATEGORIES), 'every category is reported');
  assert.equal(cats.rendering.before, 26);
  assert.equal(cats.rendering.after, 14);
  assert.equal(cats.rendering.delta, -12);
  assert.equal(cats.rendering.cap, core.CATEGORIES.rendering.cap);
  assert.equal(cats.locale.delta, 0);
  assert.equal(
    mirror.categories.reduce((sum, c) => sum + c.delta, 0),
    mirror.totals.delta,
    'category deltas must add up to the total delta',
  );

  // exact values are honestly unavailable, and the reason says why
  assert.equal(mirror.exactValues.available, false);
  assert.match(mirror.exactValues.reason, /redact/i);
  assert.ok(
    mirror.exactValues.reason.length > 40,
    'the reason must be a sentence a reader can act on',
  );
  assert.equal(mirror.summary.exactValueChanges, null);

  const sig = Object.fromEntries(mirror.signals.map((s) => [s.id, s]));
  assert.deepEqual(
    mirror.signals.map((s) => s.id),
    core.PROBE_CATALOG.map((p) => p.id),
    'signals stay in catalog order',
  );

  assert.equal(sig.canvas.statusBefore, 'ok');
  assert.equal(sig.canvas.statusAfter, 'denied');
  assert.equal(sig.canvas.statusChanged, true);
  assert.equal(sig.canvas.detailBefore, 'full');
  assert.equal(sig.canvas.detailAfter, 'none');
  assert.equal(sig.canvas.pointsBefore, 12);
  assert.equal(sig.canvas.pointsAfter, 0);
  assert.equal(sig.canvas.pointsDelta, -12);
  assert.equal(sig.canvas.exposure, 'decreased');
  assert.deepEqual(sig.canvas.changes, ['status', 'detail', 'points']);

  assert.equal(sig.webgl.statusChanged, false);
  assert.equal(sig.webgl.detailBefore, 'full');
  assert.equal(sig.webgl.detailAfter, 'coarse');
  assert.equal(sig.webgl.pointsDelta, -6);
  assert.equal(sig.webgl.exposure, 'decreased');
  assert.deepEqual(sig.webgl.changes, ['detail', 'points']);

  assert.equal(sig.languages.exposure, 'unchanged');
  assert.equal(sig.languages.pointsDelta, 0);
  assert.deepEqual(sig.languages.changes, [], 'structurally identical is no change');
  assert.equal(sig.languages.changed, false);
  assert.equal(
    sig.languages.valueComparison,
    'unavailable',
    'a redacted side cannot support an exact value comparison',
  );
  assert.equal(sig.languages.valueBefore, null);
  assert.equal(sig.languages.valueAfter, null);

  assert.equal(mirror.summary.changedCount, 2);
  assert.equal(mirror.summary.decreased, 2);
  assert.equal(mirror.summary.increased, 0);
  assert.equal(mirror.summary.unchanged, core.PROBE_CATALOG.length - 2);
  assert.ok(mirror.semantics.length > 60, 'the comparison states its own semantics');

  // purely functional: repeatable, no mutation, and no value text anywhere
  const frozen = core.stableStringify({ a, b });
  assert.deepEqual(core.compareReports(a, b), mirror);
  assert.equal(core.stableStringify({ a, b }), frozen, 'comparing must not mutate its inputs');
  assert.ok(!core.stableStringify(mirror).includes('Mozilla'));

  // reversing the sides reverses the sign, it does not change the magnitude
  const back = core.compareReports(b, a);
  assert.equal(back.totals.delta, 12);
  assert.equal(back.signals.find((s) => s.id === 'canvas').exposure, 'increased');

  assert.throws(() => core.compareReports(a, null), /two imported reports/);
  assert.throws(() => core.compareReports({ signals: [] }, b), /two imported reports/);
});

// slice 31 -- when, and only when, both reports carry their observed values,
// the comparison adds exact normalised value changes on top of the structure.
test('core/mirror: adds exact value changes only when both reports carry values', () => {
  const a = importOrThrow(reportText(RAW_A, '2026-05-01T00:00:00.000Z', true));
  const b = importOrThrow(reportText(RAW_B, '2026-05-02T00:00:00.000Z', true));
  const mirror = core.compareReports(a, b);

  assert.equal(mirror.exactValues.available, true);
  assert.match(mirror.exactValues.reason, /values included|values were saved|included/i);
  assert.equal(mirror.a.redacted, false);
  assert.equal(mirror.b.redacted, false);

  const sig = Object.fromEntries(mirror.signals.map((s) => [s.id, s]));

  // a value that changed while the exposure did not
  assert.equal(sig.languages.valueComparison, 'different');
  assert.deepEqual(sig.languages.valueBefore, ['en-GB', 'en']);
  assert.deepEqual(sig.languages.valueAfter, ['en-GB', 'en', 'cy']);
  assert.equal(sig.languages.displayBefore, 'en-GB, en');
  assert.equal(sig.languages.displayAfter, 'en-GB, en, cy');
  assert.deepEqual(sig.languages.changes, ['value']);
  assert.equal(sig.languages.changed, true);
  assert.equal(sig.languages.exposure, 'unchanged', 'a value change is not an exposure change');

  // an identical reading on both sides
  assert.equal(sig.cores.valueComparison, 'same');
  assert.equal(sig.cores.valueBefore, 8);
  assert.equal(sig.cores.valueAfter, 8);
  assert.deepEqual(sig.cores.changes, []);

  // read on one side only: nothing exact to compare, but the structure still says why
  assert.equal(sig.canvas.valueComparison, 'not-read');
  assert.equal(sig.canvas.valueAfter, null);
  assert.equal(typeof sig.canvas.valueBefore.digest, 'string');
  assert.ok(!sig.canvas.changes.includes('value'), 'an unread side is not a value change');

  // changed value and reduced detail at once, reported in a fixed order
  assert.equal(sig.webgl.valueComparison, 'different');
  assert.equal(sig.webgl.valueBefore.renderer, 'Intel Iris Plus Graphics 640');
  assert.equal(sig.webgl.valueAfter.renderer, 'llvmpipe (LLVM 15.0.7)');
  assert.deepEqual(sig.webgl.changes, ['detail', 'points', 'value']);

  assert.equal(mirror.summary.exactValueChanges, 2, 'languages and webgl');
  assert.equal(mirror.summary.changedCount, 3, 'canvas, webgl and languages');
  assert.equal(mirror.totals.delta, -12, 'the structural figures are unchanged by raw inclusion');

  // one redacted side is enough to withdraw every exact comparison
  const redactedB = importOrThrow(reportText(RAW_B, '2026-05-02T00:00:00.000Z', false));
  const mixed = core.compareReports(a, redactedB);
  assert.equal(mixed.exactValues.available, false);
  assert.match(mixed.exactValues.reason, /redact/i);
  assert.equal(mixed.summary.exactValueChanges, null);
  assert.equal(mixed.totals.delta, -12, 'structural comparison survives a redacted side');
  assert.equal(mixed.summary.changedCount, 2, 'without values, only exposure changes are visible');
  for (const signal of mixed.signals) {
    assert.equal(signal.valueComparison, 'unavailable', signal.id);
    assert.equal(signal.valueBefore, null, `${signal.id} must not leak A's value`);
    assert.equal(signal.valueAfter, null);
    assert.equal(signal.displayBefore, null);
  }
  assert.ok(
    !core.stableStringify(mixed).includes('Mozilla'),
    'a mixed pair must not carry values from the open side',
  );
});

// slice 32 -- the saved comparison must be safe to hand to someone else by
// default: it records which signals changed without recording what they were.
test('core/mirror: the comparison export omits exact values unless opted in', () => {
  const stampA = '2026-05-01T00:00:00.000Z';
  const stampB = '2026-05-02T00:00:00.000Z';
  const a = importOrThrow(reportText(RAW_A, stampA, true));
  const b = importOrThrow(reportText(RAW_B, stampB, true));
  const mirror = core.compareReports(a, b);

  const closed = core.buildComparisonExport(mirror);
  const closedJson = core.stableStringify(closed);

  assert.equal(closed.app, 'GLASSHOUSE');
  assert.equal(closed.kind, 'comparison');
  assert.equal(closed.comparisonVersion, core.COMPARISON_VERSION);
  assert.equal(closed.includesExactValues, false, 'redaction is the default');
  assert.equal(closed.redaction.applied, true);
  assert.deepEqual(closed.redaction.removedKeys, [...core.COMPARISON_REDACTED_KEYS]);
  assert.ok(closed.redaction.note.includes('deliberately'), 'the omission is declared deliberate');
  assert.ok(closed.notice.length > 30, 'the file states it was generated locally');
  assert.equal(closed.semantics, core.COMPARISON_SEMANTICS);

  for (const leak of ['Mozilla', 'llvmpipe', 'en-GB', 'Europe/London', 'Intel Iris']) {
    assert.ok(!closedJson.includes(leak), `a default comparison export must not contain ${leak}`);
  }

  // the audit trail survives redaction, including the fact that a value changed
  const languages = closed.signals.find((s) => s.id === 'languages');
  assert.equal(languages.valuesOmitted, true);
  assert.ok(!('valueBefore' in languages), 'the key is removed, not blanked');
  assert.ok(!('displayAfter' in languages));
  assert.equal(languages.valueComparison, 'different', 'that it changed is structural');
  assert.equal(languages.pointsBefore, 7);
  assert.equal(languages.pointsAfter, 7);
  assert.equal(closed.summary.exactValueChanges, 2);

  // both sides are identified honestly, including their own redaction state
  assert.equal(closed.reports.a.createdAt, stampA);
  assert.equal(closed.reports.a.includesRawValues, true);
  assert.equal(closed.reports.b.createdAt, stampB);
  assert.equal(closed.reports.b.total, 76);
  assert.equal(closed.exactValues.available, true, 'available at the source, and still omitted by choice');
  assert.match(closed.exactValues.reason, /omitted from this export/i, 'export metadata must describe the redaction');
  assert.doesNotMatch(closed.exactValues.reason, /are shown/i, 'a redacted export must not claim exact values are shown');
  assert.equal(closed.totals.delta, -12);
  assert.equal(closed.categories.find((c) => c.id === 'rendering').delta, -12);

  // explicit opt-in, and only a literal boolean
  const open = core.buildComparisonExport(mirror, { includeExactValues: true });
  assert.equal(open.includesExactValues, true);
  assert.equal(open.redaction.applied, false);
  assert.deepEqual(open.redaction.removedKeys, []);
  assert.equal(
    open.signals.find((s) => s.id === 'webgl').valueAfter.renderer,
    'llvmpipe (LLVM 15.0.7)',
  );
  assert.equal(open.signals.find((s) => s.id === 'languages').valuesOmitted, undefined);
  for (const sneaky of ['true', 1, 'yes', {}, [1]]) {
    assert.equal(
      core.buildComparisonExport(mirror, { includeExactValues: sneaky }).includesExactValues,
      false,
      `only boolean true opts in, got ${JSON.stringify(sneaky)}`,
    );
  }

  // opting in cannot conjure values a redacted pair never had
  const redactedPair = core.compareReports(
    importOrThrow(reportText(RAW_A, stampA, false)),
    importOrThrow(reportText(RAW_B, stampB, false)),
  );
  const forced = core.buildComparisonExport(redactedPair, { includeExactValues: true });
  assert.equal(forced.includesExactValues, false);
  assert.equal(forced.redaction.applied, true);
  assert.match(forced.redaction.note, /redact/i, 'the note explains why nothing exact is there');
  assert.equal(forced.exactValues.available, false);
  assert.equal(forced.totals.delta, -12, 'the structural comparison is still exported in full');

  // deterministic and non-mutating
  const frozen = core.stableStringify(mirror);
  assert.equal(core.stableStringify(core.buildComparisonExport(mirror)), closedJson);
  assert.equal(core.stableStringify(mirror), frozen, 'exporting must not mutate the comparison');
  assert.throws(() => core.buildComparisonExport(null), /comparison/i);
});

// slice 33 -- MIRROR MATCH needs real, labelled, keyboard-operable controls and
// its own polite live region, and it must delegate every decision to the core.
test('html/mirror: exposes accessible import controls and a live result region', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const script = html.slice(html.indexOf('<script type="module">'));

  assert.match(html, /<section[^>]*aria-labelledby="mirror-heading"/i, 'needs a labelled section');
  assert.match(html, /<h2\b[^>]*id="mirror-heading"[^>]*>[^<]*Compare/i, 'needs a Compare heading');

  for (const id of [
    'mirror-a',
    'mirror-b',
    'mirror-run',
    'mirror-clear',
    'mirror-save',
    'mirror-include-values',
    'mirror-status',
    'mirror-body',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing control #${id}`);
  }

  for (const id of ['mirror-a', 'mirror-b']) {
    assert.match(
      html,
      new RegExp(`<input\\b[^>]*type="file"[^>]*id="${id}"`, 'i'),
      `${id} must be a real file input`,
    );
    assert.match(
      html,
      new RegExp(`<label\\b[^>]*for="${id}"`, 'i'),
      `${id} needs a real label, not a placeholder`,
    );
    assert.match(html, new RegExp(`id="${id}"[^>]*accept="[^"]*json`, 'i'), `${id} needs an accept`);
  }
  for (const id of ['mirror-run', 'mirror-clear', 'mirror-save']) {
    assert.match(html, new RegExp(`<button\\b[^>]*id="${id}"`, 'i'), `${id} must be a button`);
  }
  assert.match(html, /<input\b[^>]*type="checkbox"[^>]*id="mirror-include-values"/i);
  assert.match(html, /<label\b[^>]*for="mirror-include-values"/i, 'the opt-in needs a label');

  // its own status region, so an import message never overwrites the scan's
  assert.match(
    html,
    /id="mirror-status"[^>]*role="status"[^>]*aria-live="polite"/i,
    'the import needs its own polite live region',
  );
  assert.ok(
    (html.match(/aria-live="polite"/g) || []).length >= 2,
    'the scan and the import each need a live region',
  );

  // the page states the bound and the redaction semantics it enforces
  assert.ok(
    html.includes(core.REPORT_IMPORT_LIMITS.maxBytesLabel),
    `the page must state the ${core.REPORT_IMPORT_LIMITS.maxBytesLabel} bound`,
  );
  assert.match(html, /report version 1/i, 'the page must state which reports it can read');
  assert.match(html, /redact/i, 'the page must explain redacted-versus-raw semantics');

  // every decision is delegated to the tested core
  for (const fn of ['parseReportText', 'compareReports', 'buildComparisonExport']) {
    assert.ok(script.includes(`core.${fn}(`), `page must call core.${fn}()`);
  }
  for (const forbidden of [
    'function parseReportText',
    'function validateReport',
    'function compareReports',
    'function buildComparisonExport',
    'COMPARISON_REDACTED_KEYS =',
    'valuesOmitted:',
    'raw-flag-invalid',
  ]) {
    assert.ok(!script.includes(forbidden), `page must not reimplement ${forbidden}`);
  }

  assert.equal((html.match(/<h1\b/g) || []).length, 1, 'still exactly one h1');
  assert.ok(!/onclick=/i.test(html), 'still no inline event handlers');
});

// slice 34 -- the strongest claim Mirror Match makes is that an imported report
// is never persisted and never leaves the tab. That has to be checked
// structurally, over a delimited region, not taken on trust from the prose.
test('html/mirror: keeps imported reports local, unpersisted and off the network', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const start = html.indexOf('/* mirror match: begin');
  const end = html.indexOf('/* mirror match: end');
  assert.notEqual(start, -1, 'the mirror-match code must be delimited so it can be audited');
  assert.ok(end > start, 'the mirror-match region must be closed');
  const region = html.slice(start, end);
  assert.ok(region.length > 1500, 'the region looks suspiciously small');

  for (const persistence of [
    'localStorage',
    'sessionStorage',
    'setItem',
    'removeItem',
    'indexedDB',
    'openDatabase',
    'cookie',
    'caches',
    'showSaveFilePicker',
    'getDirectoryHandle',
  ]) {
    assert.ok(!region.includes(persistence), `an imported report must never reach ${persistence}`);
  }

  for (const outward of [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'FormData',
    'action=',
    'postMessage',
    'BroadcastChannel',
    'src=',
    'mailto:',
  ]) {
    assert.ok(!region.includes(outward), `the import path must not reference ${outward}`);
  }

  // files are read with the chosen File's own local reader, and the documented
  // size bound is enforced before any read happens
  assert.ok(region.includes('.text()'), 'a chosen file is read with its own local text() reader');
  assert.ok(
    region.includes('core.REPORT_IMPORT_LIMITS.maxBytes'),
    'the page must enforce the documented size bound',
  );
  assert.ok(
    region.indexOf('core.REPORT_IMPORT_LIMITS.maxBytes') < region.indexOf('.text()'),
    'an oversized file must be refused before it is read',
  );

  // validation is complete before any visible comparison state is written
  const runStart = region.indexOf('async function runMirrorMatch()');
  assert.notEqual(runStart, -1, 'the region needs a single run entry point');
  const runBody = region.slice(runStart, region.indexOf('function clearMirror(', runStart));
  const guard = runBody.indexOf('if (failures.length > 0)');
  const commit = runBody.indexOf('mirrorState.a = ');
  const render = runBody.indexOf('renderMirror(');
  assert.ok(guard !== -1, 'the runner must gate on collected validation failures');
  assert.ok(guard < commit, 'imported state is committed only after validation succeeds');
  assert.ok(commit < render, 'nothing is rendered before the comparison exists');
  assert.ok(
    runBody.includes('const runId = ++mirrorRunId') &&
      runBody.includes('if (runId !== mirrorRunId) return;'),
    'an asynchronous read must not commit after clear or invalidation cancels its run',
  );
  assert.ok(
    runBody.includes('mirrorEls.fileA.disabled = true') &&
      runBody.includes('mirrorEls.fileB.disabled = true'),
    'both file pickers must be locked while their asynchronous reads are in flight',
  );
  assert.ok(
    runBody.includes('finally') &&
      runBody.includes('mirrorEls.fileA.disabled = false') &&
      runBody.includes('mirrorEls.fileB.disabled = false'),
    'the runner must always unlock both file pickers after reading',
  );
  assert.ok(
    runBody.includes('discardMirror();'),
    'a refusal must discard both imports rather than leave a half-import',
  );

  // clearing resets both inputs, the result region and the in-memory state
  const clearStart = region.indexOf('function clearMirror(');
  const clearBody = region.slice(clearStart, region.indexOf('function exportMirror(', clearStart));
  for (const reference of ['discardMirror()', 'mirrorEls.fileA', 'mirrorEls.fileB', 'mirrorEls.body']) {
    assert.ok(clearBody.includes(reference), `clearing must reset ${reference}`);
  }
  assert.ok(clearBody.includes(".value = ''"), 'clearing must reset the chosen files');
  assert.ok(clearBody.includes('mirrorRunId += 1'), 'clearing must cancel any file reads still in flight');
  assert.ok(clearBody.includes('replaceChildren()'), 'clearing must empty the result region');

  // the imports live in one module-scope object, so a reload discards them
  assert.ok(
    /const mirrorState = \{ a: null, b: null, comparison: null \};/.test(region),
    'imports must live in one module-scope object with no initial value',
  );
  assert.equal(
    (region.match(/mirrorState\.comparison = core\.compareReports\(/g) || []).length,
    1,
    'exactly one place may produce the current comparison',
  );

  // changing either chosen file invalidates the previous comparison, so a saved
  // file can never describe a pair that is no longer selected
  assert.ok(
    region.includes('function invalidateMirror()'),
    'the region needs a single invalidation path',
  );
  const invalidateBody = region.slice(
    region.indexOf('function invalidateMirror()'),
    region.indexOf('async function readMirrorFile('),
  );
  assert.ok(invalidateBody.includes('discardMirror()'), 'invalidation must discard both imports');
  assert.ok(
    invalidateBody.includes('replaceChildren()'),
    'invalidation must remove the stale comparison from the page',
  );
  for (const input of ['fileA', 'fileB']) {
    assert.ok(
      new RegExp(`mirrorEls\\.${input}\\.addEventListener\\('change', invalidateMirror\\)`).test(
        region,
      ),
      `changing ${input} must invalidate the previous comparison`,
    );
  }

  // the export path is the tested, redaction-aware core one
  assert.ok(region.includes('core.buildComparisonExport('), 'export must use the tested builder');
  assert.ok(region.includes('core.stableStringify('), 'the comparison file must be deterministic');
  assert.ok(region.includes('createObjectURL'), 'saving is a local file download');
  assert.ok(
    region.includes('mirrorEls.includeValues.checked === true'),
    'the exact-values opt-in must be read as a strict boolean',
  );
});

// slice 35 -- the README must describe Mirror Match as it actually behaves,
// with its numbers and its rejection vocabulary derived from the code.
test('readme/mirror: documents the workflow, bound, schema and honest limits', async () => {
  const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const source = await readFile(new URL('./core.mjs', import.meta.url), 'utf8');

  assert.ok(
    /^#{2,3}\s.*Mirror Match/im.test(readme),
    'README needs a "Mirror Match" section',
  );

  // the workflow, by the names the controls actually carry
  for (const control of [
    'Compare reports',
    'Save comparison JSON',
    'Clear imported reports',
    'Report A',
    'Report B',
  ]) {
    assert.ok(readme.includes(control), `README must document the "${control}" step`);
  }

  // the bound, stated in both the label and the byte figure the code enforces
  assert.ok(
    readme.includes(core.REPORT_IMPORT_LIMITS.maxBytesLabel),
    `README must state the ${core.REPORT_IMPORT_LIMITS.maxBytesLabel} bound`,
  );
  assert.ok(
    readme.includes(String(core.REPORT_IMPORT_LIMITS.maxBytes)),
    'README must state the bound in bytes, as enforced',
  );

  // the schema assumptions
  assert.ok(
    readme.includes(`report version ${core.REPORT_VERSION}`),
    'README must state which report version is readable',
  );
  assert.ok(
    readme.includes(`snapshot version ${core.SNAPSHOT_VERSION}`),
    'README must state which snapshot version is readable',
  );

  // the rejection vocabulary cannot drift from the validator
  const emitted = [...source.matchAll(/importError\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(emitted.length > 10, 'expected the validator to emit a real set of codes');
  assert.deepEqual(
    [...new Set(emitted)].sort(),
    [...core.REPORT_IMPORT_ERROR_CODES].sort(),
    'REPORT_IMPORT_ERROR_CODES must list exactly the codes the validator can emit',
  );
  for (const code of [...core.REPORT_IMPORT_ERROR_CODES, 'no-file', 'unreadable']) {
    assert.ok(readme.includes(`\`${code}\``), `README must document rejection code ${code}`);
  }

  // redacted-versus-raw semantics, in both directions
  assert.ok(
    /redacted/i.test(readme) && readme.includes('structural'),
    'README must explain that a redacted report still compares structurally',
  );
  for (const key of core.COMPARISON_REDACTED_KEYS) {
    assert.ok(readme.includes(`\`${key}\``), `README must name the removed key ${key}`);
  }
  assert.ok(
    readme.includes('glasshouse-comparison-redacted.json'),
    'README must name the default comparison file',
  );
  assert.ok(
    readme.includes('glasshouse-comparison-with-values.json'),
    'README must name the opted-in comparison file',
  );

  // the privacy boundary is restated for imports specifically
  for (const claim of ['never written to', 'reload']) {
    assert.ok(readme.includes(claim), `README must state that imports are transient (${claim})`);
  }

  // and Mirror Match must not be sold as something it is not
  for (const overclaim of [
    'same device',
    'proves',
    'identical device',
    'confirms your identity',
    'more private than',
  ]) {
    assert.ok(
      !new RegExp(overclaim, 'i').test(readme),
      `README must not claim "${overclaim}" about a comparison`,
    );
  }
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
async function main() {
  const selected = only ? tests.filter((t) => t.name.includes(only)) : tests;

  if (listOnly) {
    for (const t of selected) console.log(t.name);
    return 0;
  }

  let passed = 0;
  const failures = [];

  for (const t of selected) {
    try {
      await t.fn();
      passed += 1;
      console.log(`PASS  ${t.name}`);
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
        .split('\n')
        .slice(0, 4)
        .join(' | ');
      failures.push({ name: t.name, message });
      console.log(`FAIL  ${t.name}: ${message}`);
    }
  }

  const suffix = only ? ` (filter: ${only})` : '';
  console.log(
    `\nverify: ${passed} passed, ${failures.length} failed, ${selected.length} selected, ${tests.length} defined${suffix}`,
  );

  if (only && selected.length === 0) {
    console.log('verify: filter matched no tests');
    return 2;
  }
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
