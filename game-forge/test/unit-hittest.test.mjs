import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeHittable, hittableFor, sweepScenarios, hitMessage, hittableSummary, DEFAULT_HIT_VIEWPORTS,
} from '../src/hittest.mjs';
import { loadConfig } from '../src/harness.mjs';

describe('normalizeHittable — unified config form', () => {
  test('array shorthand gets three default viewports', () => {
    const h = normalizeHittable(['#code', '#shop']);
    assert.deepEqual(h.selectors, ['#code', '#shop']);
    assert.deepEqual(h.viewports, DEFAULT_HIT_VIEWPORTS);
    assert.deepEqual(DEFAULT_HIT_VIEWPORTS, ['desktop', 'phoneLandscape', 'phone']);
    assert.deepEqual(h.setup, []);
    assert.equal(h.settleMs, 1000);
  });

  test('full form preserves viewports and setup steps', () => {
    const setup = [{ eval: 'skip()' }];
    const h = normalizeHittable({ selectors: ['#a'], viewports: ['tablet'], setup });
    assert.deepEqual(h.viewports, ['tablet']);
    assert.equal(h.setup, setup);
  });

  test('missing section means no protection and is valid', () => {
    assert.equal(normalizeHittable(undefined), null);
    assert.equal(normalizeHittable(null), null);
    assert.equal(normalizeHittable(false), null);
  });

  test('empty list errors instead of silently disabling protection', () => {
    // Otherwise a key typo or selectors: [] would produce a passing
    // run without performing any checks.
    assert.throws(() => normalizeHittable([]), /nonempty array/);
    assert.throws(() => normalizeHittable({ selectors: [] }), /nonempty array/);
    assert.throws(() => normalizeHittable({ selectors: ['#a', ''] }), /nonempty array/);
    assert.throws(() => normalizeHittable({ selector: '#a' }), /nonempty array/);
  });

  test('viewport typo errors at load time rather than mid-run', () => {
    assert.throws(() => normalizeHittable({ selectors: ['#a'], viewports: ['phoneLandscpe'] }), /Unknown viewport/);
    assert.throws(() => normalizeHittable({ selectors: ['#a'], viewports: 'phone' }), /array of viewport names/);
    assert.throws(() => normalizeHittable({ selectors: ['#a'], setup: { eval: 'x' } }), /array of scenario steps/);
    assert.throws(() => normalizeHittable({ selectors: ['#a'], settleMs: '2s' }), /settleMs/);
    assert.equal(normalizeHittable({ selectors: ['#a'], settleMs: 3000 }).settleMs, 3000);
  });

  test('loadConfig validates the section with the same check', async () => {
    // One directory per config: loadConfig uses timestamped imports, so two
    // configs in the same file within a millisecond would hit the cache.
    const load = (body) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hit-'));
      fs.writeFileSync(path.join(dir, 'forge.config.mjs'), `export default ${body};`);
      return loadConfig(dir);
    };
    await assert.rejects(() => load('{ hittable: { selectors: ["#a"], viewports: ["nope"] } }'), /Unknown viewport "nope"/);
    assert.deepEqual((await load('{ hittable: ["#a"] }')).hittable.selectors, ['#a']);
    assert.equal((await load('{}')).hittable, null);
  });
});

describe('hittableFor — end-of-scenario checks', () => {
  const cfg = { hittable: normalizeHittable(['#code', '#shop']) };

  test('defaults to the config list', () => {
    assert.deepEqual(hittableFor({ name: 'x' }, cfg), ['#code', '#shop']);
  });

  test('scenario ending in a modal can opt out', () => {
    assert.deepEqual(hittableFor({ hittable: false }, cfg), []);
  });

  test('scenario may narrow the list or define its own without config', () => {
    assert.deepEqual(hittableFor({ hittable: ['#code'] }, cfg), ['#code']);
    assert.deepEqual(hittableFor({ hittable: ['#go'] }, {}), ['#go']);
  });

  test('no config or scenario means nothing to check', () => {
    assert.deepEqual(hittableFor({}, {}), []);
  });
});

describe('sweepScenarios — viewport sweep', () => {
  test('one scenario per viewport with steps from setup', () => {
    const setup = [{ eval: 'skip()' }];
    const list = sweepScenarios({ hittable: normalizeHittable({ selectors: ['#a'], setup }) });
    assert.deepEqual(list.map((s) => s.name), ['hittable@desktop', 'hittable@phoneLandscape', 'hittable@phone']);
    assert.deepEqual(list.map((s) => s.viewport), ['desktop', 'phoneLandscape', 'phone']);
    for (const s of list) assert.equal(s.steps, setup);
  });

  test('explicit --viewport collapses the sweep to one run', () => {
    // Flag overrides the scenario viewport, so three identical runs would
    // add no coverage.
    const list = sweepScenarios({ hittable: normalizeHittable(['#a']) }, 'tablet');
    assert.deepEqual(list.map((s) => s.name), ['hittable@tablet']);
  });

  test('no section means no sweep; empty viewport list disables it', () => {
    assert.deepEqual(sweepScenarios({}), []);
    assert.deepEqual(sweepScenarios({ hittable: normalizeHittable({ selectors: ['#a'], viewports: [] }) }), []);
  });
});

describe('hitMessage — obstruction and actionable diagnostics', () => {
  test('overlay names the top element, its layer and target layer', () => {
    const msg = hitMessage('#shop', {
      reason: 'covered', x: 1055.4, y: 467, hit: 'img.bg', owner: 'div#art',
      layer: { el: 'div#art', z: '3' }, self: null,
    });
    assert.match(msg, /«#shop» is covered/);
    assert.match(msg, /\(1055, 467\)/);
    assert.match(msg, /img\.bg inside div#art/);
    assert.match(msg, /layer div#art, z-index 3/);
    assert.match(msg, /no explicit z-index/);
  });

  test('target layer reports its z-index to explain why it loses', () => {
    const msg = hitMessage('#tabs', {
      reason: 'covered', x: 1, y: 2, hit: 'div#art', owner: null,
      layer: { el: 'div#art', z: '3' }, self: { el: 'div#tabs', z: '2' },
    });
    assert.match(msg, /div#art \(layer div#art, z-index 3\) is on top/);
    assert.match(msg, /z-index 2 on div#tabs/);
  });

  test('other failure reasons remain distinguishable', () => {
    assert.match(hitMessage('#a', { reason: 'missing' }), /not found on the page/);
    assert.match(hitMessage('#a', { reason: 'invisible', w: 0, h: 0 }), /not visible: 0×0/);
    assert.match(hitMessage('#a', { reason: 'invisible', w: 10, h: 10, visibility: 'hidden' }), /visibility: hidden/);
    assert.match(hitMessage('#a', { reason: 'offscreen', w: 10, h: 10, rect: [900, 0], vw: 390, vh: 844 }), /outside.*390×844/);
    assert.match(hitMessage('#a', { reason: 'offscreen', w: 10, h: 10, rect: [0, 900], vw: 390, vh: 844, locked: 'div#list' }),
      /cannot scroll there; overflow: hidden on div#list/);
    assert.match(hitMessage('#a', { reason: 'disabled' }), /is disabled/);
    assert.match(hitMessage('.up', { reason: 'invisible', w: 0, h: 0, count: 4 }), /all 4 matches/);
    assert.match(hitMessage('#a', { reason: 'no-pointer-events' }), /pointer-events: none/);
    assert.match(hitMessage('#a', { reason: 'bad-selector', error: 'Unexpected token' }), /invalid selector/);
  });
});

describe('hittableSummary — one probe check', () => {
  test('failure collects every reason', () => {
    const c = hittableSummary([
      { name: 'hittable «#a»', status: 'fail', detail: 'A is covered', selector: '#a' },
      { name: 'hittable «#b»', status: 'pass', detail: '', selector: '#b' },
    ]);
    assert.equal(c.name, 'hittable');
    assert.equal(c.status, 'fail');
    assert.equal(c.detail, 'A is covered');
  });

  test('success lists checked selectors', () => {
    const c = hittableSummary([{ status: 'pass', selector: '#a' }, { status: 'pass', selector: '#b' }, { status: 'pass', selector: '#a' }]);
    assert.equal(c.status, 'pass');
    assert.match(c.detail, /#a, #b/);
  });
});
