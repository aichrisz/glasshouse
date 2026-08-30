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
