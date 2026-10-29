import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadAdapter } from '../src/harness.mjs';
import { probe } from '../src/probe.mjs';
import { runScenarios } from '../src/scenario.mjs';
import { simulate } from '../src/sim.mjs';
import { analyze } from '../src/analyze.mjs';
import { findChromium } from '../src/browser.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const GAME = path.join(ROOT, 'fixtures/tiny-game');
const FORGE = path.join(ROOT, 'game-forge/bin/forge.mjs');

// Browserless end-to-end tests are meaningless: skip explicitly rather than falsely passing.
const hasBrowser = !!findChromium();
const opts = { skip: hasBrowser ? false : 'Chromium is not installed: npx playwright-core install chromium' };

let cfg;
before(async () => { cfg = await loadConfig(GAME); });

describe('probe', opts, () => {
  test('measures frame work, detects a live image and does not invent errors', async () => {
    const { metrics } = await probe(cfg, { seconds: 3 });
    assert.equal(metrics.errorCount, 0, 'fixture must be clean');
    assert.equal(metrics.verdict, 'pass');

    assert.ok(metrics.frameWorkMs >= 0 && metrics.frameWorkMs < 16.7, `frame work ${metrics.frameWorkMs} ms`);
    assert.ok(metrics.frameWorkMs < metrics.frameIntervalMs,
      'work must be shorter than cadence or we are measuring the wrong quantity');
    assert.ok(metrics.mainThreadBusy >= 0 && metrics.mainThreadBusy <= 1);

    const alive = metrics.checks.find((c) => c.name === 'frame-alive');
    assert.equal(alive.status, 'pass');
    assert.ok(metrics.canvas.distinctColors > 2, 'the screenshot must contain drawing');
  });

  test('budget enforcement: a low bundle-size limit fails the verdict', async () => {
    const strict = { ...cfg, budgets: { ...cfg.budgets, bundleKb: 0 } };
    const { metrics } = await probe(strict, { seconds: 2 });
    assert.equal(metrics.verdict, 'fail');
    assert.equal(metrics.checks.find((c) => c.name === 'bundle').status, 'fail');
  });
});

describe('probe --scenario', opts, () => {
  test('prepares the requested scene before measurement', async () => {
    // Otherwise all 20 measurement seconds could pass in the starting room,
    // leaving peak-scene preparation to a human.
    const plain = await probe(cfg, { seconds: 2 });
    const late = await probe(cfg, { seconds: 2, scenario: 'late-game' });
    assert.equal(late.metrics.scenario, 'late-game');
    assert.equal(plain.metrics.scenario, null);
    assert.ok(late.metrics.state.level > plain.metrics.state.level,
      `scene must be further along: ${late.metrics.state.level} vs ${plain.metrics.state.level}`);
  });

  test('missing scenario gives a clear error listing available scenarios', async () => {
    await assert.rejects(() => probe(cfg, { seconds: 1, scenario: 'nonexistent' }), /Available: smoke, late-game/);
  });

  test('uses scenario viewport unless overridden by an explicit flag', async () => {
    // A phone scenario at 1280 pixels measures a different scene: layout,
    // scale and the number of visible objects differ.
    const file = path.join(GAME, 'forge', 'scenarios.phone.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'phone-peak', viewport: 'phone', selector: '#game',
      steps: [{ forge: ['start'], tick: 120 }],
    }];`);
    try {
      const scoped = { ...cfg, scenariosFile: file };
      const auto = await probe(scoped, { seconds: 1, scenario: 'phone-peak' });
      assert.equal(auto.metrics.viewport, 'phone', 'scenario viewport overrides config viewport');

      const forced = await probe(scoped, { seconds: 1, scenario: 'phone-peak', viewport: 'desktop' });
      assert.equal(forced.metrics.viewport, 'desktop', 'explicit --viewport overrides scenario');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('false expectation during scene setup cancels measurement', async () => {
    // Failed expectations used to disappear with a disposable checks array,
    // letting probe measure an unprepared scene.
    const file = path.join(GAME, 'forge', 'scenarios.badprep.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'badprep', viewport: 'desktop', selector: '#game',
      steps: [
        { forge: ['start'], tick: 60 },
        { expect: { fn: () => window.__FORGE__.state().score > 1e9, msg: 'scene reached peak state' } },
      ],
    }];`);
    try {
      await assert.rejects(
        () => probe({ ...cfg, scenariosFile: file }, { seconds: 2, scenario: 'badprep' }),
        /was not prepared.*scene reached peak state/s,
      );
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('measurement validity on a live page', opts, () => {
  test('zero duration is rejected before launching the browser', async () => {
    await assert.rejects(() => probe(cfg, { seconds: 0 }), /positive number/);
  });

  test('dead render loop fails despite a visually live screenshot', async () => {
    // Fixture draws once and never redraws. Probe runs its own rAF and counts
    // dozens of frames, falsely suggesting everything is fine.
    const deadCfg = await loadConfig(path.join(ROOT, 'fixtures/dead-game'));
    const { metrics } = await probe(deadCfg, { seconds: 2 });

    assert.ok(metrics.frames >= 20, `probe frames ${metrics.frames} advance independently of the game`);
    assert.equal(metrics.gameFrames, 0, 'game did not draw a single frame');
    assert.equal(metrics.checks.find((c) => c.name === 'frame-alive').status, 'pass',
      'a static image fools the live-frame check; sample validity must catch it');
    assert.equal(metrics.checks.find((c) => c.name === 'frame-work'), undefined,
      'frame statistics do not exist without frames: zero work used to be reported as PASS');
    assert.equal(metrics.checks.find((c) => c.name === 'sample').status, 'fail');
    assert.equal(metrics.verdict, 'fail');
  });

  test('empty rAF loop is not presented as a live game', async () => {
    // Fixture runs requestAnimationFrame(loop) with an empty body: game frames
    // advance continuously while the image freezes. Only render checks detect it.
    const zombieCfg = await loadConfig(path.join(ROOT, 'fixtures/zombie-game'));
    const { metrics } = await probe(zombieCfg, { seconds: 2 });

    assert.ok(metrics.gameFrames >= 20, `game frames ${metrics.gameFrames}: loop is alive`);
    assert.equal(metrics.paintFrames, 0,
      'no commands on game canvas even though an adjacent HUD canvas draws each frame');
    assert.equal(metrics.pixelChange, 0, 'no game-canvas pixel changed');
    assert.equal(metrics.checks.find((c) => c.name === 'sample').status, 'pass',
      'game-frame sample is complete, which makes a zombie dangerous');
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'fail');
    assert.equal(metrics.verdict, 'fail');
  });

  test('healthy rendering is observable', async () => {
    const { metrics } = await probe(cfg, { seconds: 2 });
    assert.ok(metrics.paintFrames >= 20, `painted frames ${metrics.paintFrames}`);
    assert.ok(metrics.pixelChange > 0, `canvas pixel change ${metrics.pixelChange}`);
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'pass');
  });

  test('offscreen drawing does not vouch for a frozen visible screen', async () => {
    // Missing blit: scene draws every frame into an invisible canvas.
    // Rendering must be tied to the visible surface, otherwise an offscreen
    // helper would vouch for a dead screen.
    const ghostCfg = await loadConfig(path.join(ROOT, 'fixtures/ghost-backbuffer'));
    const { metrics } = await probe(ghostCfg, { seconds: 2 });

    assert.equal(metrics.paintFrames, 0, 'offscreen canvas does not count as visible rendering');
    assert.ok(metrics.gameFrames >= 20, 'loop is alive and drawing');
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'fail');
    assert.equal(metrics.verdict, 'fail');
  });

  test('true on-demand rendering without rAF is not classified as dead', async () => {
    // Wordle pattern: draw from the input handler without starting rAF.
    // Zero game frames are expected rather than a defect.
    // Previous fixture used an empty rAF loop, hiding this gap.
    const dirtyCfg = await loadConfig(path.join(ROOT, 'fixtures/dirty-render'));
    const onDemand = await probe(dirtyCfg, { seconds: 2 });

    assert.equal(onDemand.metrics.renderMode, 'on-demand');
    assert.equal(onDemand.metrics.gameFrames, 0, 'rAF was never called');
    assert.equal(onDemand.metrics.checks.find((c) => c.name === 'sample').status, 'warn');
    assert.notEqual(onDemand.metrics.verdict, 'fail', 'a healthy turn-based game must not fail CI');

    // Without declaring on-demand mode, the same game fails: a frozen screen
    // cannot be accepted until the game explicitly declares event-driven rendering.
    const strict = await probe({ ...dirtyCfg, renderMode: 'continuous' }, { seconds: 2 });
    assert.equal(strict.metrics.checks.find((c) => c.name === 'sample').status, 'fail');
    assert.equal(strict.metrics.verdict, 'fail');
  });

  test('rendering that dies during the window fails the run', async () => {
    // Rendering runs for the first 1.5 seconds and stops. Its painted-frame
    // ratio remains high; only the window tail detects it.
    const dyingCfg = await loadConfig(path.join(ROOT, 'fixtures/dying-render'));
    const { metrics } = await probe(dyingCfg, { seconds: 3 });

    assert.ok(metrics.paintFrames > 0, 'game initially rendered');
    assert.ok(metrics.lastPaintAt < metrics.frames * 0.75,
      `last paint at frame ${metrics.lastPaintAt} of ${metrics.frames}`);
    const render = metrics.checks.find((c) => c.name === 'render');
    assert.equal(render.status, 'fail');
    assert.match(render.detail, /rendering stopped/);
    assert.ok(metrics.paintFrames / metrics.gameFrames >= 0.5,
      `ratio ${metrics.paintFrames}/${metrics.gameFrames}: fixture must render fully before dying`);
    assert.equal(metrics.verdict, 'fail');
  });

  test('finished animation waiting for input is not classified as dead', async () => {
    // Title, pause and win screens all stop drawing and wait for input.
    // Without synthetic input this cannot be distinguished from dead rendering,
    // so warn rather than fail; failing here would block a healthy
    // game.
    const introCfg = await loadConfig(path.join(ROOT, 'fixtures/settling-intro'));
    const { metrics } = await probe(introCfg, { seconds: 3 });

    assert.ok(metrics.paintFrames > 0, 'intro rendered');
    assert.ok(metrics.paintFrames < metrics.gameFrames, 'then stopped rendering');
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'warn');
    assert.notEqual(metrics.verdict, 'fail');
  });

  test('HUD declared before the game canvas does not steal the measurement', async () => {
    // document.querySelector('canvas') picked the first canvas, possibly a
    // preloader, background or score strip, and failed healthy games.
    const hudCfg = await loadConfig(path.join(ROOT, 'fixtures/hud-first'));
    const { metrics } = await probe(hudCfg, { seconds: 2 });

    assert.ok(metrics.paintFrames >= 20, `painted frames ${metrics.paintFrames}`);
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'pass');
    assert.equal(metrics.verdict, 'pass');
  });

  test('drawing from a timer outside game frames does not count as game rendering', async () => {
    // Empty rAF loop plus drawing setInterval: pixels change and commands run,
    // but outside game frames, so they cannot vouch for a live game loop.
    const outsideCfg = await loadConfig(path.join(ROOT, 'fixtures/outside-loop'));
    const { metrics } = await probe(outsideCfg, { seconds: 2 });

    assert.equal(metrics.paintFrames, 0, 'no commands from inside a game frame');
    assert.ok(metrics.pixelChange > 0, 'image still changes');
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'warn');
  });

  test('canvas displayed after loading is not classified as non-rendering', async () => {
    // Cached clientWidth visibility retained its first result forever,
    // giving a splash-screen game zero painted frames and a failed verdict.
    const lateCfg = await loadConfig(path.join(ROOT, 'fixtures/late-canvas'));
    const { metrics } = await probe(lateCfg, { seconds: 2 });

    assert.ok(metrics.paintFrames >= 20, `painted frames ${metrics.paintFrames}`);
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'pass');
    assert.equal(metrics.verdict, 'pass');
  });

  test('rare drawing remains rare: the frame flag does not stick', async () => {
    // Fixture draws once every 60 frames. Without resetting the flag, one draw
    // would mark every subsequent frame painted and raise the ratio to 100%.
    const blinkCfg = await loadConfig(path.join(ROOT, 'fixtures/blink-game'));
    const { metrics } = await probe(blinkCfg, { seconds: 3 });

    assert.ok(metrics.paintFrames > 0, 'some drawing occurred');
    assert.ok(metrics.paintFrames < metrics.gameFrames / 4,
      `${metrics.paintFrames} of ${metrics.gameFrames}: ratio must remain low`);
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'warn');
  });

  test('failed start() cancels measurement and leaves a failed artifact', async () => {
    // Adapter contract requires start(). Swallowing its error would measure
    // the title screen while pretending to measure gameplay.
    const file = path.join(GAME, 'forge', 'adapter.broken.mjs');
    fs.writeFileSync(file, `export default {
      autostart: true, tickRate: 60,
      install() {
        window.__FORGE__ = {
          ready: true,
          start() { throw new Error('title screen failed to initialize'); },
          tick() {}, state() { return { over: false, score: 0, level: 1 }; },
        };
      },
    };`);
    try {
      await assert.rejects(
        () => probe({ ...cfg, adapterFile: file }, { seconds: 2 }),
        /start\(\) failed.*title screen failed to initialize/s,
      );
      const p = JSON.parse(fs.readFileSync(
        path.join(fs.realpathSync(path.join(GAME, '.forge', 'latest-probe')), 'probe.json'), 'utf8'));
      assert.equal(p.verdict, 'fail');
      assert.equal(p.checks[0].name, 'scene');
      assert.match(p.checks[0].detail, /start\(\) failed/);
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('live game is counted using game frames, not just probe frames', async () => {
    const { metrics } = await probe(cfg, { seconds: 2 });
    assert.ok(metrics.gameFrames >= 20, `game frames ${metrics.gameFrames}`);
    assert.ok(metrics.gameFrames <= metrics.frames);
    assert.match(metrics.checks.find((c) => c.name === 'sample').detail, /game frames/);
  });

  test('normal run collects a sample and passes the sample check', async () => {
    const { metrics } = await probe(cfg, { seconds: 2 });
    assert.ok(metrics.frames >= 20, `frames ${metrics.frames}: sample must accumulate within 2 seconds`);
    assert.ok(metrics.workSamples > 0 && metrics.frameSamples > 0);
    assert.equal(metrics.checks.find((c) => c.name === 'sample').status, 'pass');
  });
});

describe('draw-call budget on a live page', opts, () => {
  test('rare heavy frame fails the budget despite a normal average', async () => {
    const spikeCfg = await loadConfig(path.join(ROOT, 'fixtures/spike-frame'));
    const { metrics } = await probe(spikeCfg, { seconds: 4 });
    assert.ok(metrics.drawCallsMedian <= 10, `median ${metrics.drawCallsMedian}: ordinary frames are cheap`);
    assert.ok(metrics.drawCallsMax >= 600, `peak ${metrics.drawCallsMax}`);
    assert.equal(metrics.checks.find((c) => c.name === 'draw-calls').status, 'fail');

    // WebGL drawing must count like 2D drawing; otherwise every WebGL game
    // would fail as dead rendering without any test catching the regression.
    assert.ok(metrics.paintFrames >= 20, `painted frames ${metrics.paintFrames}: WebGL counts as rendering`);
    assert.notEqual(metrics.checks.find((c) => c.name === 'render').status, 'fail');
  });
});

describe('scenarios', opts, () => {
  test('play passes and captures screenshots', async () => {
    const { summary, dir } = await runScenarios(cfg, { kind: 'play' });
    assert.equal(summary.status, 'pass');
    const sc = summary.scenarios[0];
    assert.equal(sc.checks.filter((c) => c.status !== 'pass').length, 0);
    assert.equal(sc.shots.length, 2);
    for (const s of sc.shots) {
      assert.ok(fs.existsSync(s.file), `screenshot ${s.label} must exist`);
      assert.ok(fs.statSync(s.file).size > 500, 'PNG must not be empty');
    }
    assert.ok(fs.existsSync(path.join(dir, 'play.json')));
  });

  test('failed expectation fails the scenario status', async () => {
    // Deliberately false expectation: if this run passes, assertions are
    // useless and play no longer acts as a gate.
    const file = path.join(GAME, 'forge', 'scenarios.broken.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'broken', viewport: 'desktop', selector: '#game',
      steps: [
        { forge: ['start'], tick: 60 },
        { expect: { fn: () => window.__FORGE__.state().score > 1e9, msg: 'deliberately false condition' } },
      ],
    }];`);
    try {
      const { summary } = await runScenarios({ ...cfg, scenariosFile: file }, { kind: 'play' });
      assert.equal(summary.status, 'fail');
      const failed = summary.scenarios[0].checks.filter((c) => c.status === 'fail');
      assert.equal(failed.length, 1);
      assert.match(failed[0].name, /false condition/);
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('simulation', opts, () => {
  test('determinism: same seed gives the same result', async () => {
    const a = await simulate(cfg, { runs: 3, maxTicks: 5000, seed0: 777, bots: ['veteran'] });
    const b = await simulate(cfg, { runs: 3, maxTicks: 5000, seed0: 777, bots: ['veteran'] });
    const strip = (rs) => rs.map((r) => ({ ticks: r.ticks, score: r.final.score, level: r.final.level }));
    assert.deepEqual(strip(a.runs), strip(b.runs), 'balance fixes cannot be verified without determinism');
  });

  test('different seeds produce different runs', async () => {
    const a = await simulate(cfg, { runs: 4, maxTicks: 5000, seed0: 1, bots: ['casual'] });
    const b = await simulate(cfg, { runs: 4, maxTicks: 5000, seed0: 500, bots: ['casual'] });
    const t = (r) => r.runs.map((x) => x.ticks).join(',');
    assert.notEqual(t(a), t(b), 'otherwise the seed has no effect');
  });

  test('skill matters: veteran outperforms casual', async () => {
    const { dir } = await simulate(cfg, { runs: 10, maxTicks: 20000, seed0: 42 });
    const a = analyze(dir);
    const win = (n) => a.bots.find((b) => b.bot === n).winrate;
    assert.ok(win('veteran') >= win('casual'), `veteran ${win('veteran')} vs casual ${win('casual')}`);
    assert.ok(!a.flags.some((f) => f.kind === 'bot-suspect'));
  });

  test('simulation is orders of magnitude faster than real time', async () => {
    const { meta } = await simulate(cfg, { runs: 6, maxTicks: 20000, bots: ['veteran'] });
    assert.ok(meta.ticksPerSecond > 10000, `${meta.ticksPerSecond} ticks/s: too slow, is rendering still enabled?`);
  });

  test('difficulty curve uses adapter events', async () => {
    const { dir } = await simulate(cfg, { runs: 8, maxTicks: 20000, seed0: 7 });
    const a = analyze(dir);
    assert.ok(a.levels.length >= 3, 'fixture completes multiple levels');
    for (const L of a.levels) {
      assert.ok(L.attempts >= L.clears, 'attempts cannot be fewer than clears');
      assert.ok(L.clearRate === null || (L.clearRate >= 0 && L.clearRate <= 1));
    }
  });
});

describe('CLI', opts, () => {
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync('node', [FORGE, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };

  test('all exits with zero on a healthy game', () => {
    const r = run(['all', GAME, '--runs', '4', '--max-ticks', '20000']);
    assert.equal(r.code, 0, r.out.slice(-600));
    assert.match(r.out, /run passed/);
  });

  test('all returns a nonzero exit when probe fails', () => {
    // Original defect: report said Needs work while CI saw success.
    const tmpCfg = path.join(GAME, 'forge.config.mjs');
    const original = fs.readFileSync(tmpCfg, 'utf8');
    fs.writeFileSync(tmpCfg, original.replace('bundleKb: 64', 'bundleKb: 1'));
    try {
      const r = run(['all', GAME, '--runs', '4', '--max-ticks', '20000']);
      assert.notEqual(r.code, 0, 'failed run must fail CI');
      assert.match(r.out, /run failed/);
    } finally {
      fs.writeFileSync(tmpCfg, original);
    }
  });

  test('disabled stage does not reuse an old failed run', () => {
    // Review scenario: yesterday sim failed, today the adapter is disabled.
    // Previously ?? substituted old analysis, making the report fail while
    // the exit status used the empty current result and remained zero.
    const cfgFile = path.join(GAME, 'forge.config.mjs');
    const original = fs.readFileSync(cfgFile, 'utf8');
    const simDir = path.join(GAME, '.forge', 'latest-sim');

    // Ensure an old failed analysis exists.
    execFileSync('node', [FORGE, 'sim', GAME, '--runs', '4', '--max-ticks', '5000'], { encoding: 'utf8' });
    const analysisFile = path.join(fs.realpathSync(simDir), 'analysis.json');
    const analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    analysis.verdict = 'needs-work';
    analysis.flags = [{ kind: 'wall', level: 1, severity: 'high', detail: 'previous wall' }];
    fs.writeFileSync(analysisFile, JSON.stringify(analysis));

    // Disable both adapter and scenarios: fixture scenarios require the
    // adapter and would otherwise fail, masking the behavior under test.
    fs.writeFileSync(cfgFile, original.replace(/\s*(adapter|scenarios): .*,\n/g, '\n'));
    try {
      const r = run(['all', GAME]);
      assert.equal(r.code, 0, 'current run is clean, so exit status must be zero');
      const reportFile = path.join(fs.realpathSync(path.join(GAME, '.forge', 'latest-report')), 'index.html');
      const html = fs.readFileSync(reportFile, 'utf8');
      assert.doesNotMatch(html, /previous wall/, 'old run must not leak into a new report');
      assert.doesNotMatch(html, /Needs work/);
    } finally {
      fs.writeFileSync(cfgFile, original);
    }
  });

  test('probe --seconds 0 errors instead of reporting a passing gate', () => {
    const r = run(['probe', GAME, '--seconds', '0']);
    assert.notEqual(r.code, 0, 'zero measurement must be an error');
    assert.match(r.out, /positive number/);
    assert.doesNotMatch(r.out, /PASS/, 'no passing checks for a measurement that never happened');
  });

  test('scenario viewport reaches the CLI and --viewport overrides it', () => {
    // CLI-to-probe plumbing previously injected c.viewport, preventing the
    // scenario override. Direct probe() tests did not catch this.
    const file = path.join(GAME, 'forge', 'scenarios.mjs');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('export default [', `export default [
      { name: 'phone-peak', viewport: 'phone', selector: '#game', steps: [{ forge: ['start'], tick: 120 }] },`));
    const viewportOf = () => JSON.parse(fs.readFileSync(
      path.join(fs.realpathSync(path.join(GAME, '.forge', 'latest-probe')), 'probe.json'), 'utf8')).viewport;
    try {
      assert.equal(run(['probe', GAME, '--seconds', '1', '--scenario', 'phone-peak']).code, 0);
      assert.equal(viewportOf(), 'phone', 'scenario viewport');

      assert.equal(run(['probe', GAME, '--seconds', '1', '--scenario', 'phone-peak', '--viewport', 'desktop']).code, 0);
      assert.equal(viewportOf(), 'desktop', 'explicit flag takes precedence');

      // --key=value previously broke the key, skipped setup and falsely passed.
      assert.equal(run(['probe', GAME, '--seconds', '1', '--scenario=phone-peak']).code, 0);
      assert.equal(viewportOf(), 'phone', '--scenario=name must behave identically');
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  test('flag without a value errors rather than silently using a default', () => {
    // forge probe game --viewport $VP with an empty variable measured a
    // different device class and still passed.
    const vp = run(['probe', GAME, '--seconds', '1', '--viewport', '--strict']);
    assert.notEqual(vp.code, 0);
    assert.match(vp.out, /--viewport requires a value/);

    const sc = run(['probe', GAME, '--seconds', '1', '--scenario', '--strict']);
    assert.notEqual(sc.code, 0);
    assert.match(sc.out, /--scenario requires a value/);
  });

  test('failed scene setup leaves a failed artifact rather than the previous passing one', () => {
    const file = path.join(GAME, 'forge', 'scenarios.mjs');
    const original = fs.readFileSync(file, 'utf8');
    const probeJson = () => JSON.parse(fs.readFileSync(
      path.join(fs.realpathSync(path.join(GAME, '.forge', 'latest-probe')), 'probe.json'), 'utf8'));

    assert.equal(run(['probe', GAME, '--seconds', '1']).code, 0);
    assert.equal(probeJson().verdict, 'pass', 'first run passes');

    fs.writeFileSync(file, original.replace('export default [', `export default [
      { name: 'badprep', viewport: 'desktop', selector: '#game', steps: [
        { forge: ['start'], tick: 60 },
        { expect: { fn: () => window.__FORGE__.state().score > 1e9, msg: 'scene reached peak state' } },
      ] },`));
    try {
      const r = run(['probe', GAME, '--seconds', '1', '--scenario', 'badprep']);
      assert.notEqual(r.code, 0);
      const p = probeJson();
      assert.equal(p.verdict, 'fail', 'latest-probe must show the failed measurement, not the previous pass');
      assert.equal(p.checks[0].name, 'scene');
      assert.match(p.checks[0].detail, /scene reached peak state/);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  test('doctor prints the environment', () => {
    const r = run(['doctor']);
    assert.match(r.out, /Chromium/);
    assert.match(r.out, /Node/);
  });

  test('unknown game gives a clear error rather than a stack trace', () => {
    const r = run(['probe', '/tmp/nonexistent-forge-game']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /forge\.config\.mjs/);
  });
});

describe('fixture adapter', opts, () => {
  test('conforms to the ADAPTER.md contract', async () => {
    const adapter = await loadAdapter(cfg);
    assert.equal(typeof adapter.install, 'function');
    assert.equal(adapter.tickRate, 60);
    // install is serialized into the browser; closures over module variables
    // do not survive the transfer, so the body must not contain imports.
    const src = adapter.install.toString();
    assert.doesNotMatch(src, /\bimport\b|\brequire\(/);
  });
});
