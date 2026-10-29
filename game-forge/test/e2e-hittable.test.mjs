import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, boot } from '../src/harness.mjs';
import { hittableChecks } from '../src/hittest.mjs';
import { probe } from '../src/probe.mjs';
import { runScenarios } from '../src/scenario.mjs';
import { findChromium } from '../src/browser.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const GAME = path.join(ROOT, 'fixtures/covered-button');
const FORGE = path.join(ROOT, 'game-forge/bin/forge.mjs');

const hasBrowser = !!findChromium();
const opts = { skip: hasBrowser ? false : 'Chromium is not installed: npx playwright-core install chromium' };

// Reproduces bum2billionaire on 2026-09-23: full-screen artwork at z-index 3.
// The tutorial initially raises the button above it; after the first click
// the button drops below the artwork. DOM clicks still worked, so play passed.
const COVERED = /«#go» is covered: at \(\d+, \d+\), div\.hero inside div#art \(layer div#art, z-index 3\) is on top/;

let cfg;
before(async () => { cfg = await loadConfig(GAME); });

describe('hittability: scenarios', opts, () => {
  let summary;
  const byName = (n) => summary.scenarios.find((s) => s.scenario === n);
  const failed = (n) => byName(n).checks.filter((c) => c.status === 'fail');

  before(async () => { ({ summary } = await runScenarios(cfg, { kind: 'play' })); });

  test('covered button fails the entire run', () => {
    assert.equal(summary.status, 'fail');
  });

  test('healthy scenarios pass with desktop mouse and phone touch', () => {
    // A false failure blocks work just as reliably as a false pass lets defects
    // through. Scenario expectations check both click count and input type.
    for (const n of ['click-ok', 'tap-ok']) {
      assert.equal(byName(n).status, 'pass', `${n}: ${JSON.stringify(failed(n))}`);
    }
    assert.equal(byName('tap-ok').viewport, 'phone');
  });

  test('second real click hits and identifies the artwork', () => {
    const f = failed('second-click-covered');
    assert.equal(f.length, 1);
    assert.equal(f[0].name, 'step 1', 'step number rather than check count');
    assert.match(f[0].detail, COVERED);
    assert.match(f[0].detail, /click 2 of 2/, 'first click passed; identify the one that failed');
  });

  test('DOM clicks pass steps; only the final hittability check detects the overlay', () => {
    const sc = byName('dom-click-hides-it');
    assert.equal(sc.checks.find((c) => /DOM clicks/.test(c.name)).status, 'pass',
      'el.click() bypasses artwork: the exact hole that let bum2billionaire pass');
    const hit = sc.checks.find((c) => c.name === 'hittable «#go»');
    assert.equal(hit.status, 'fail');
    assert.match(hit.detail, COVERED);
  });

  test('hittable: false exempts a scenario from the check', () => {
    const sc = byName('opted-out');
    assert.equal(sc.status, 'pass');
    assert.equal(sc.checks.some((c) => c.name.startsWith('hittable')), false);
  });

  test('hittable@ sweep covers desktop and both phone orientations', () => {
    for (const vp of ['desktop', 'phoneLandscape', 'phone']) {
      const sc = byName(`hittable@${vp}`);
      assert.ok(sc, `sweep ${vp} did not run`);
      assert.equal(sc.viewport, vp);
      assert.equal(sc.status, 'fail');
      assert.match(failed(`hittable@${vp}`)[0].detail, COVERED);
    }
  });

  test('failure captures a page screenshot identifying the obstruction', () => {
    const shot = byName('dom-click-hides-it').shots.find((s) => s.label === 'hittable');
    assert.ok(shot && fs.existsSync(shot.file), 'missing failure screenshot');
    assert.ok(fs.statSync(shot.file).size > 500);
    assert.match(shot.note, /div#art/);
  });
});

describe('hittability: healthy sweep', opts, () => {
  test('new player tutorial raises the button and the sweep passes on all viewports', async () => {
    // Same page without setup: tutorial keeps the button above the artwork.
    // A failure here would detect something other than the overlay.
    const fresh = { ...cfg, hittable: { ...cfg.hittable, setup: [] } };
    const { summary } = await runScenarios(fresh, { kind: 'play', only: null });
    const sweep = summary.scenarios.filter((s) => s.scenario.startsWith('hittable@'));
    assert.equal(sweep.length, 3);
    for (const s of sweep) assert.equal(s.status, 'pass', `${s.scenario}: ${JSON.stringify(s.checks)}`);
  });

  test('--only selects the named sweep without running the others', async () => {
    const { summary } = await runScenarios(cfg, { kind: 'play', only: 'hittable@phone' });
    assert.deepEqual(summary.scenarios.map((s) => s.scenario), ['hittable@phone']);
  });
});

describe('hittability: selector click', opts, () => {
  test('uses the same check and fails quickly rather than after 30 seconds', async () => {
    // Playwright page.click also noticed overlays, but waited half a minute
    // and reported intercepts pointer events without layer or z-index details.
    const file = path.join(GAME, 'forge', 'scenarios.click.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'legacy-click', viewport: 'desktop', hittable: false,
      steps: [{ click: '#go', times: 2 }],
    }];`);
    try {
      const t0 = Date.now();
      const { summary } = await runScenarios({ ...cfg, scenariosFile: file, hittable: null }, { kind: 'play' });
      assert.ok(Date.now() - t0 < 20000, `run took ${Date.now() - t0} ms`);
      const f = summary.scenarios[0].checks.filter((c) => c.status === 'fail');
      assert.equal(f.length, 1);
      assert.match(f[0].detail, COVERED);
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('hittable step checks without clicking or aborting the scenario', async () => {
    const file = path.join(GAME, 'forge', 'scenarios.step.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'step-check', viewport: 'desktop', hittable: false,
      steps: [
        { hittable: '#go' },
        { eval: 'window.__game.clickGo()' },
        { hittable: ['#go', '#nope'] },
        { expect: { fn: () => window.clicks === 1, msg: 'scenario reached the end' } },
      ],
    }];`);
    try {
      const { summary } = await runScenarios({ ...cfg, scenariosFile: file, hittable: null }, { kind: 'play' });
      const checks = summary.scenarios[0].checks;
      assert.deepEqual(checks.map((c) => c.status), ['pass', 'fail', 'fail', 'pass']);
      assert.match(checks[1].detail, COVERED);
      assert.match(checks[2].detail, /«#nope» not found on the page/);
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('hittability: probe --scenario', opts, () => {
  test('end-of-scene overlay fails the verdict while measurement continues', async () => {
    const { metrics } = await probe(cfg, { seconds: 1, scenario: 'dom-click-hides-it' });
    const hit = metrics.checks.find((c) => c.name === 'hittable');
    assert.equal(hit.status, 'fail');
    assert.match(hit.detail, COVERED);
    assert.equal(metrics.verdict, 'fail');
    assert.ok(metrics.frames > 0, 'finding rather than aborted setup: probe frames were sampled');
  });

  test('healthy scene passes', async () => {
    const { metrics } = await probe(cfg, { seconds: 1, scenario: 'click-ok' });
    assert.equal(metrics.checks.find((c) => c.name === 'hittable').status, 'pass');
    assert.notEqual(metrics.verdict, 'fail');
  });

  test('probe without a scenario does not check hittability', async () => {
    // Check is tied to scenario completion: without a scenario, the state
    // in which the game must be hittable is unknown.
    const { metrics } = await probe(cfg, { seconds: 1 });
    assert.equal(metrics.checks.find((c) => c.name === 'hittable'), undefined);
  });
});

describe('hittability: reachability', opts, () => {
  // PR #9 findings: touch missed buttons on wide pages, false failure in
  // scrollable list rows, false passes for buttons inside overflow: hidden
  // containers and disabled buttons, and a 2-second wait on continuous
  // animation.
  let summary, reachCfg;
  const byName = (n) => summary.scenarios.find((s) => s.scenario === n);
  const failOf = (n) => byName(n).checks.find((c) => c.status === 'fail');

  before(async () => {
    reachCfg = await loadConfig(path.join(ROOT, 'fixtures/hit-reach'));
    ({ summary } = await runScenarios(reachCfg, { kind: 'play' }));
  });

  test('phone touch hits buttons beyond screen edges, in lists and below the screen', () => {
    // Visibility used to rely on innerWidth: on wider pages touch missed
    // the button while the step still passed.
    for (const n of ['reach-phone', 'reach-desktop']) {
      assert.equal(byName(n).status, 'pass', `${n}: ${JSON.stringify(failOf(n))}`);
    }
  });

  test('click waits for enablement without delaying continuous animation', () => {
    assert.equal(byName('pulse').status, 'pass', JSON.stringify(failOf('pulse')));
  });

  test('disabled button fails with a reason rather than silently skipping', () => {
    assert.match(failOf('dead').detail, /«#dead» is disabled; a real click would have no effect/);
  });

  test('check does not scroll where the player cannot scroll', () => {
    // scrollIntoView scrolls overflow: hidden too; without restoring it,
    // the check would pass for an unreachable button.
    assert.match(failOf('locked').detail, /«#inlocked» outside the player viewport.*overflow: hidden on div#locked/);
    assert.match(failOf('page-locked').detail, /«#below» outside the player viewport.*overflow: hidden on body/);
  });

  test('horizontal locks and fixed/absolute buttons do not cause false offscreen findings', () => {
    // Second review: inline: center moved the locked axis of the shop list,
    // while clipping used all ancestors rather than the containing block.
    // reach-* expectations check clicks on #buy, #full and #abs; here we
    // verify that a check without clicking restores the scroll position.
    for (const n of ['reach-phone', 'reach-desktop']) {
      const back = byName(n).checks.find((c) => c.name === 'check preserved scroll position');
      assert.equal(back?.status, 'pass', `${n}: ${JSON.stringify(back)}`);
    }
  });

  test('fullscreen CSS: locked body fails; scrollable body passes and restores scrolling', () => {
    // Third review: with html, body { overflow: hidden }, body is its own
    // scroll container; skipping it produced a false pass.
    assert.match(failOf('body-locked').detail, /«#below» outside the player viewport.*overflow: hidden on body/);
    assert.equal(byName('body-free').status, 'pass', JSON.stringify(failOf('body-free')));
  });

  test('shadow DOM button inside a scrollable list can be clicked', () => {
    // parentElement traversal stopped at shadow roots. reach-* scenario
    // expectations check the click on #sb.
    assert.equal(byName('reach-desktop').status, 'pass');
  });

  test('check alone does not wake the game with scroll events', () => {
    assert.equal(byName('quiet-check').status, 'pass', JSON.stringify(failOf('quiet-check')));
  });

  test('mid-scenario failure restores scrolling and the next real scroll reaches the game', () => {
    const sc = byName('fail-shot-scrolled');
    assert.match(failOf('fail-shot-scrolled').detail, /«#below» is covered.*div#cover/);
    for (const msg of ['mid-scenario failure preserved scroll position', 'real scroll after the check reached the game']) {
      assert.equal(sc.checks.find((c) => c.name === msg)?.status, 'pass', msg);
    }
    assert.ok(sc.shots.some((s) => s.label === 'hittable'), 'end-of-scenario failure screenshot exists');
  });

  test('keepOnFail scrolls to the overlay only when requested', async () => {
    // End-of-scenario failure screenshot must show the overlay at the
    // diagnostic coordinates; mid-scenario checks preserve scroll position.
    const ctx = await boot(reachCfg, { viewport: 'desktop' });
    try {
      await ctx.page.evaluate(() => {
        const b = document.getElementById('below').getBoundingClientRect();
        const v = document.createElement('div');
        Object.assign(v.style, { position: 'absolute', left: `${b.left}px`, top: `${b.top + scrollY}px`,
          width: `${b.width}px`, height: `${b.height}px`, zIndex: 9 });
        document.body.appendChild(v);
        window.scrollTo(0, 0);
      });
      const plain = await hittableChecks(ctx.page, ['#below'], 0);
      assert.equal(plain[0].status, 'fail');
      assert.equal(await ctx.page.evaluate(() => window.scrollY), 0, 'scroll preserved unless requested');
      await hittableChecks(ctx.page, ['#below'], 0, { keepOnFail: true });
      assert.ok(await ctx.page.evaluate(() => window.scrollY) > 0, 'keepOnFail scrolled to the overlay');
    } finally {
      await ctx.dispose();
    }
  });

  test('invalid selector fails immediately with a reason rather than a missing-element timeout', () => {
    const f = failOf('bad-selector');
    assert.match(f.detail, /«div\[» — invalid selector/);
    assert.doesNotMatch(f.detail, /waited/, 'waiting cannot fix a selector typo');
  });

  test('probe checks hittability at the same point as play, before its measurement window', async () => {
    // Button is covered 2.5 seconds after scenario completion. play sees
    // it unobstructed; probe would see an overlay after its 3-second window.
    assert.equal(byName('late-cover').status, 'pass');
    const { metrics } = await probe(reachCfg, { seconds: 3, scenario: 'late-cover' });
    assert.equal(metrics.checks.find((c) => c.name === 'hittable').status, 'pass');
  });

  test('failed probe hittable step is a finding rather than aborted setup', async () => {
    const { metrics } = await probe(reachCfg, { seconds: 1, scenario: 'locked' });
    const hit = metrics.checks.find((c) => c.name === 'hittable');
    assert.equal(hit.status, 'fail');
    assert.match(hit.detail, /div#locked/);
    assert.ok(metrics.frames > 0, 'measurement completed');
    assert.equal(metrics.verdict, 'fail');
  });
});

describe('hittability: CLI', opts, () => {
  test('play exits with code 2 for a covered button', () => {
    let code = 0, out = '';
    try {
      out = execFileSync('node', [FORGE, 'play', GAME], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
      out = (e.stdout || '') + (e.stderr || '');
    }
    assert.equal(code, 2, out.slice(-800));
    assert.match(out, /div#art/);
  });
});
