import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, evaluateBudgets, prepareScene, probe, MIN_FRAMES } from '../src/probe.mjs';
import { resolveViewport } from '../src/browser.mjs';

/** Raw data in the format returned by the page. */
const raw = ({
  work = Array(100).fill(1), draws = Array(100).fill(5), drawsMax = 5,
  frames = 100, gameFrames = frames, paintFrames = gameFrames, lastPaintAt = frames,
  drawsTotal = 500, times = Array(100).fill(8.3), longFrames = 0,
} = {}) => ({
  frames, gameFrames, paintFrames, lastPaintAt, longFrames, times,
  work, workTotal: work.reduce((a, b) => a + b, 0), workMax: work.length ? Math.max(...work) : 0,
  draws, drawsMax, drawsTotal,
  elapsedMs: 1000, heapBytes: 10 * 1048576, dpr: 2, state: null,
});

const cfg = (budgets = {}) => ({ name: 'T', renderer: '2d', budgets });
const opts = { viewport: 'desktop', seconds: 4 };

describe('budget draw calls', () => {
  test('catches a peak even with a tiny average', () => {
    // Exact review reproduction: one frame with 600 calls among 99 cheap frames.
    // The average is about 12, which would pass a budget of 150.
    const draws = [...Array(99).fill(6), 600];
    const m = computeMetrics(raw({ draws, drawsMax: 600, frames: 100, drawsTotal: 1194 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.drawCallsAvg, 12, 'the average really is small');
    assert.equal(m.drawCallsMax, 600);
    // One frame out of 100 is exactly 1% of the sample, and p99 misses it.
    // The gate therefore uses the maximum: players will notice the stall.
    assert.equal(m.checks.find((c) => c.name === 'draw-calls').status, 'fail');
    assert.equal(m.verdict, 'fail');
  });

  test('a steady profile within budget passes', () => {
    const m = computeMetrics(raw({ draws: Array(100).fill(80), drawsMax: 80, frames: 100, drawsTotal: 8000 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.checks.find((c) => c.name === 'draw-calls').status, 'pass');
  });

  test('a single heavy frame among 100 still fails the budget', () => {
    // Separate boundary check where p99 is useless
    const draws = [...Array(99).fill(10), 400];
    const m = computeMetrics(raw({ draws, drawsMax: 400, frames: 100, drawsTotal: 1390 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.drawCallsP99, 10, 'p99 really misses this frame');
    assert.equal(m.checks.find((c) => c.name === 'draw-calls').status, 'fail');
  });

  test('exceeding the budget by a factor of 1.5 warns rather than fails', () => {
    const m = computeMetrics(raw({ draws: Array(100).fill(200), drawsMax: 200, frames: 100, drawsTotal: 20000 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.checks.find((c) => c.name === 'draw-calls').status, 'warn');
  });

  test('without a budget there is no check; it is meaningless for 2D games', () => {
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}) });
    assert.equal(m.checks.find((c) => c.name === 'draw-calls'), undefined);
  });
});

describe('headroom', () => {
  test('uses the configured budget rather than 16.7', () => {
    // 3D-prototypes set frameMs: 8; 10 ms of work leaves no headroom
    const m = computeMetrics(raw({ work: Array(10).fill(10) }), { ...opts, cfg: cfg({ frameMs: 8 }) });
    assert.equal(m.budgetMs, 8);
    assert.ok(m.headroom < 1, `headroom ×${m.headroom}: 10 ms of work exceeds the 8 ms budget`);
    assert.equal(m.checks.find((c) => c.name === 'frame-work').status, 'warn');
  });

  test('default 16.7 is retained when no budget is configured', () => {
    const m = computeMetrics(raw({ work: Array(10).fill(1) }), { ...opts, cfg: cfg({}) });
    assert.equal(m.budgetMs, 16.7);
    assert.equal(m.headroom, 16.7);
  });
});

describe('evaluateBudgets', () => {
  const base = {
    frameWorkMs: 1, frameWorkP99Ms: 2, frameWorkMaxMs: 3, mainThreadBusy: 0.1, headroom: 16,
    errorCount: 0, errors: [], bundleKb: 10, loadMs: 100,
    drawCallsP99: 10, drawCallsMax: 12, drawCallsMedian: 9, longFrames: 0, frames: 100,
    gameFrames: 100, paintFrames: 100, lastPaintAt: 100, workSamples: 100, frameSamples: 100,
    longFrameRatio: 0, pixelChange: 0.02, seconds: 4,
  };

  test('software WebGL downgrades frame failure to warning', () => {
    const hard = evaluateBudgets({ ...base, frameWorkMs: 100, softwareGl: false }, { frameMs: 16.7 });
    const soft = evaluateBudgets({ ...base, frameWorkMs: 100, softwareGl: true }, { frameMs: 16.7 });
    assert.equal(hard.find((c) => c.name === 'frame-work').status, 'fail');
    assert.equal(soft.find((c) => c.name === 'frame-work').status, 'warn');
    assert.match(soft.find((c) => c.name === 'frame-work').detail, /software WebGL/);
  });

  test('dead frame fails', () => {
    const checks = evaluateBudgets({ ...base, canvas: { distinctColors: 1, minLum: 0, maxLum: 0 } }, {});
    assert.equal(checks.find((c) => c.name === 'frame-alive').status, 'fail');
  });

  test('frame decoding errors are not reported as dead frames', () => {
    const checks = evaluateBudgets({ ...base, canvas: { error: 'not PNG' } }, {});
    assert.equal(checks.find((c) => c.name === 'frame-alive'), undefined);
  });
});

describe('sample sufficiency', () => {
  const sample = (m) => m.checks.find((c) => c.name === 'sample');

  test('zero frames fail rather than pass', () => {
    // Repro from review: `--seconds 0` gave PASS, 0/0 frames and exit code 0,
    // creating a performance gate that any game could pass.
    const empty = raw({ work: [], draws: [], drawsMax: 0, frames: 0, drawsTotal: 0, times: [] });
    const m = computeMetrics(empty, { ...opts, seconds: 0.001, cfg: cfg({ drawCalls: 150 }) });

    assert.equal(m.frames, 0);
    assert.equal(m.frameWorkMs, 0, 'zero work alone looks perfect');
    // Previously printed as PASS: zero milliseconds fits any
    // budget, showing many passing checks below a failing sample check.
    assert.equal(m.checks.find((c) => c.name === 'frame-work'), undefined,
      'frame metrics do not exist without frames; omission is more honest');
    assert.equal(m.checks.find((c) => c.name === 'draw-calls'), undefined);
    assert.equal(sample(m).status, 'fail');
    assert.equal(m.verdict, 'fail', 'empty measurements must fail the verdict');
  });

  test('detects a dead render loop even while probe frames continue', () => {
    // Second review: the probe runs its OWN rAF and counts frames for a page,
    // that rendered once and never redraws.
    // Probe frames cannot validate this gate; count game frames.
    const dead = raw({ work: Array(90).fill(0), frames: 90, gameFrames: 0 });
    const m = computeMetrics(dead, { ...opts, seconds: 3, cfg: cfg({}) });

    assert.equal(m.frames, 90, 'probe frames continue');
    assert.equal(m.gameFrames, 0, 'but the game rendered none');
    assert.equal(m.workSamples, 90, 'work samples exist but are all zero');
    assert.equal(sample(m).status, 'fail');
    assert.match(sample(m).detail, /did not draw a single frame/);
    assert.equal(m.verdict, 'fail');
  });

  test('frames without work samples also fail, for a different reason', () => {
    // All work values were filtered as invalid: instrumentation is broken.
    const m = computeMetrics(raw({ work: Array(50).fill(9e9), frames: 50 }), { ...opts, cfg: cfg({}) });
    assert.equal(m.workSamples, 0);
    assert.equal(sample(m).status, 'fail');
    assert.match(sample(m).detail, /frame instrumentation is broken/);
    assert.doesNotMatch(sample(m).detail, /--seconds/, 'increasing --seconds would address the wrong issue');
    assert.equal(m.verdict, 'fail');
  });

  test('true on-demand without rAF is not broken; frame cost is unmeasured', () => {
    // Wordle draws inside input handlers and never starts rAF:
    // there are no game frames by definition. renderMode did not prevent this; sample
    // required five frames regardless of mode, failing a healthy game.
    const onDemand = { name: 'T', renderer: '2d', renderMode: 'on-demand', budgets: {} };
    const idle = raw({ work: Array(120).fill(0), frames: 120, gameFrames: 0, paintFrames: 0, lastPaintAt: 0 });
    const m = computeMetrics(idle, { ...opts, seconds: 3, cfg: onDemand, pixelChange: 0 });

    assert.equal(sample(m).status, 'warn');
    assert.match(sample(m).detail, /draws on events/);
    assert.notEqual(m.verdict, 'fail', 'a healthy turn-based game must not fail CI');
    assert.equal(m.checks.find((c) => c.name === 'frame-work'), undefined, 'there is no frame cost here');
  });

  test('on-demand does not excuse a broken loop: a few frames mean failure', () => {
    // The exception applies only when no loop existed. One to four
    // frames mean the loop started and died, regardless of renderMode.
    const onDemand = { name: 'T', renderer: '2d', renderMode: 'on-demand', budgets: {} };
    const m = computeMetrics(raw({ work: Array(200).fill(0.1), frames: 200, gameFrames: 3, paintFrames: 3, lastPaintAt: 3 }), {
      ...opts, seconds: 3, cfg: onDemand, pixelChange: 0,
    });
    assert.equal(sample(m).status, 'fail');
    assert.equal(m.verdict, 'fail');
  });

  test('but a zero measurement window still fails for on-demand', () => {
    // Event-driven rendering does not justify `--seconds 0`: this concerns the
    // missing measurement, not the game.
    const onDemand = { name: 'T', renderer: '2d', renderMode: 'on-demand', budgets: {} };
    const m = computeMetrics(raw({ work: [], draws: [], frames: 0, gameFrames: 0, paintFrames: 0, times: [] }), {
      ...opts, seconds: 0.001, cfg: onDemand,
    });
    assert.equal(sample(m).status, 'fail');
    assert.equal(m.verdict, 'fail');
  });

  test('barely enough frames warns: a number without confidence', () => {
    const thin = raw({ work: Array(8).fill(1), draws: Array(8).fill(5), frames: 8, times: Array(8).fill(8.3) });
    const m = computeMetrics(thin, { ...opts, seconds: 0.2, cfg: cfg({}) });
    assert.equal(sample(m).status, 'warn');
    assert.equal(m.verdict, 'warn');
    assert.match(sample(m).detail, /sample below 20 frames/);
  });

  test('a truncated sample on a long run warns', () => {
    // Work counters stop collecting at 4000 entries, while frames keep counting:
    // median and p99 describe the start of the window, not the whole run.
    const soak = raw({ work: Array(4000).fill(1), draws: Array(4000).fill(5), frames: 5400, times: Array(4000).fill(8.3) });
    const m = computeMetrics(soak, { ...opts, seconds: 120, cfg: cfg({}) });
    assert.equal(sample(m).status, 'warn');
    assert.match(sample(m).detail, /start of the window/);
  });

  test('a complete sample passes and populates metrics', () => {
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}) });
    assert.equal(m.workSamples, 100);
    assert.equal(m.frameSamples, 100);
    assert.equal(m.gameFrames, 100);
    assert.equal(sample(m).status, 'pass');
    assert.equal(m.verdict, 'pass');
  });

  test('the MIN_FRAMES boundary is tested explicitly', () => {
    const at = (frames) => computeMetrics(
      raw({ work: Array(frames).fill(1), draws: Array(frames).fill(5), frames, times: Array(frames).fill(8.3) }),
      { ...opts, cfg: cfg({}) },
    );
    assert.equal(sample(at(MIN_FRAMES - 1)).status, 'fail');
    assert.notEqual(sample(at(MIN_FRAMES)).status, 'fail');
  });

  test('probe.json without gameFrames (older run) uses the legacy interpretation', () => {
    const legacy = { frames: 100, workSamples: 100, frameSamples: 100, seconds: 4, frameWorkMs: 1, frameWorkP99Ms: 2, errorCount: 0, errors: [] };
    assert.equal(evaluateBudgets(legacy, {}).find((c) => c.name === 'sample').status, 'pass');
  });
});

describe('live loop versus live renderer', () => {
  const render = (m) => m.checks.find((c) => c.name === 'render');
  /** Zombie: rAF runs every frame without drawing anything. */
  const zombie = raw({ frames: 359, gameFrames: 359, paintFrames: 0, work: Array(359).fill(0.01), times: Array(359).fill(8.3) });

  test('empty rAF is not counted as rendering', () => {
    // From review: an empty `requestAnimationFrame(loop)` gave 143/143 game frames
    // and a passing verdict on a frozen image. Game frames alone are insufficient.
    const m = computeMetrics(zombie, { ...opts, seconds: 3, cfg: cfg({}), pixelChange: 0 });

    assert.equal(m.gameFrames, 359, 'the loop is alive');
    assert.equal(m.paintFrames, 0, 'but nothing was drawn');
    assert.equal(m.checks.find((c) => c.name === 'sample').status, 'pass', 'game frame sampling is fine');
    assert.equal(render(m).status, 'fail');
    assert.match(render(m).detail, /rendering is dead/);
    assert.equal(m.verdict, 'fail');
  });

  test('changing pixels without draw commands warn rather than fail', () => {
    // Workers, WebGPU, DOM/CSS: invisible to instrumentation, but the game is alive.
    // Failing here would misrepresent the game.
    const m = computeMetrics(zombie, { ...opts, seconds: 3, cfg: cfg({}), pixelChange: 0.02 });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /bypasses 2D\/WebGL/);
  });

  test('missing pixel comparisons do not prove failure', () => {
    const m = computeMetrics(zombie, { ...opts, seconds: 3, cfg: cfg({}) });
    assert.equal(m.pixelChange, null);
    assert.equal(render(m).status, 'warn');
  });

  test('an event-driven game is not declared dead', () => {
    // A turn-based game such as Wordle renders nothing during an idle measurement
    // window; this is normal. Failing would block a healthy game.
    const onDemand = { name: 'T', renderer: '2d', renderMode: 'on-demand', budgets: {} };
    const m = computeMetrics(zombie, { ...opts, seconds: 3, cfg: onDemand, pixelChange: 0 });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /on-demand/);
    assert.notEqual(m.verdict, 'fail');
  });

  test('normal rendering passes', () => {
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}), pixelChange: 0.02 });
    assert.equal(render(m).status, 'pass');
    assert.match(render(m).detail, /100 of 100 game frames/);
  });

  test('drawing every frame without pixel changes adds a note, not a warning', () => {
    // Game over, pause and quiet scenes all look like this: the game
    // redraws the same image. Warning would cry wolf on
    // every end screen, as measured with healthy tiny-game.
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}), pixelChange: 0 });
    assert.equal(render(m).status, 'pass');
    assert.match(render(m).detail, /canvas pixels did not change/);
  });

  test('full rendering followed by a stop fails', () => {
    // 61% of frames rendered: a ratio gate would pass because
    // the ratio exceeds the threshold. Only the window tail catches it.
    const m = computeMetrics(raw({ frames: 720, gameFrames: 720, paintFrames: 440, lastPaintAt: 440 }), {
      ...opts, seconds: 12, cfg: cfg({}), pixelChange: 0.02,
    });
    assert.equal(render(m).status, 'fail');
    assert.match(render(m).detail, /rendering stopped/);
    assert.equal(m.verdict, 'fail');
  });

  test('rare rendering and stopped rendering differ in the window tail', () => {
    // The ratio is identical: 5 out of 720. Only the time of the
    // last render differs.
    const stopped = computeMetrics(raw({ frames: 720, gameFrames: 720, paintFrames: 5, lastPaintAt: 5 }), {
      ...opts, seconds: 12, cfg: cfg({}), pixelChange: 0.02,
    });
    const rare = computeMetrics(raw({ frames: 720, gameFrames: 720, paintFrames: 5, lastPaintAt: 715 }), {
      ...opts, seconds: 12, cfg: cfg({}), pixelChange: 0.02,
    });
    assert.match(render(stopped).detail, /stopped/);
    assert.match(render(rare).detail, /judge|redraws/);
  });

  test('barely rendering and then stopping warns rather than fails', () => {
    // Five frames then silence could be either a dead renderer or an intro
    // that finished animating and awaits input. Without synthetic input they
    // cannot be distinguished; failing on a title screen blocks a healthy game.
    const m = computeMetrics(raw({ frames: 720, gameFrames: 720, paintFrames: 5, lastPaintAt: 5 }), {
      ...opts, seconds: 12, cfg: cfg({}), pixelChange: 0,
    });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /finished its animation and is waiting for input/);
  });

  test('a high ratio does not excuse rendering stopping near the end', () => {
    const m = computeMetrics(raw({ frames: 360, gameFrames: 360, paintFrames: 221, lastPaintAt: 221 }), {
      ...opts, seconds: 3, cfg: cfg({}), pixelChange: 0.02,
    });
    assert.equal(render(m).status, 'fail');
    assert.match(render(m).detail, /stopped/);
  });

  test('rendering half the frames counts as alive', () => {
    const m = computeMetrics(raw({ paintFrames: 60 }), { ...opts, cfg: cfg({}), pixelChange: 0.02 });
    assert.equal(render(m).status, 'pass');
  });

  test('intermittent rendering warns', () => {
    // The ratio is low, but enough rendered frames exist to judge it.
    const m = computeMetrics(raw({ frames: 360, gameFrames: 360, paintFrames: 30, lastPaintAt: 355 }), {
      ...opts, cfg: cfg({}), pixelChange: 0.02,
    });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /barely redraws/);
  });

  test('a few rendered frames mean insufficient evidence, not intermittent rendering', () => {
    // These differ: one has a meaningful ratio, the other lacks a sample. Both
    // previously printed the same ratio message, contradicting their numbers.
    const m = computeMetrics(raw({ paintFrames: 3, lastPaintAt: 98 }), { ...opts, cfg: cfg({}), pixelChange: 0.02 });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /insufficient evidence/);
  });

  test('without game frames the check stays silent rather than inventing a live loop', () => {
    // dead-game: rAF is never called. Claiming a live rAF loop with 0 game frames
    // would mislead both people and reviewer agents.
    const m = computeMetrics(raw({ frames: 90, gameFrames: 0, paintFrames: 0, work: Array(90).fill(0) }), {
      ...opts, seconds: 3, cfg: cfg({}), pixelChange: 0,
    });
    assert.equal(render(m), undefined, 'nothing can be said about rendering');
    assert.equal(m.checks.find((c) => c.name === 'sample').status, 'fail', 'failure is reported by sample');
  });

  test('old probe.json without paintFrames does not get this check', () => {
    const legacy = { frames: 100, gameFrames: 100, workSamples: 100, frameSamples: 100, frameWorkMs: 1, frameWorkP99Ms: 2, errorCount: 0, errors: [] };
    assert.equal(evaluateBudgets(legacy, {}).find((c) => c.name === 'render'), undefined);
  });

  test('an aborted measurement does not invent a rendering diagnosis', () => {
    // Previously the abort artifact claimed rendering outside 2D/WebGL despite,
    // having compared no screenshots. The report and critique inherited it.
    const m = computeMetrics(
      { frames: 0, longFrames: 0, times: [], work: [], workTotal: 0, workMax: 0, gameFrames: 0, paintFrames: null, draws: [], drawsMax: 0, drawsTotal: 0, elapsedMs: 0, heapBytes: null, state: null },
      { ...opts, cfg: cfg({}) },
    );
    assert.equal(m.paintFrames, null);
    assert.equal(render(m), undefined);
  });
});

describe('a game that stalls', () => {
  const spikes = (m) => m.checks.find((c) => c.name === 'stalls');

  test('long frames fail even when work inside rAF is tiny', () => {
    // Repro from review: heavy setInterval blocks the thread; work INSIDE rAF
    // is 0.03 ms, yet all checks passed with 13 long frames out of 13.
    const stall = raw({ work: Array(13).fill(0.03), draws: Array(13).fill(5), frames: 13, longFrames: 13, times: Array(13).fill(300) });
    const m = computeMetrics(stall, { ...opts, seconds: 4, cfg: cfg({}) });

    assert.equal(m.frameWorkMs, 0.03, 'rAF is genuinely idle here');
    assert.equal(m.longFrameRatio, 1);
    assert.equal(spikes(m).status, 'fail');
    assert.equal(m.checks.find((c) => c.name === 'frame-spikes').status, 'pass',
      'work inside the frame is unrelated; it has a separate check');
    assert.match(spikes(m).detail, /game stalls/);
    assert.equal(m.verdict, 'fail');
  });

  test('one long frame out of 100 does not prove failure', () => {
    const m = computeMetrics(raw({ longFrames: 1 }), { ...opts, cfg: cfg({}) });
    assert.equal(spikes(m).status, 'pass');
  });

  test('one fifth long frames warns', () => {
    const m = computeMetrics(raw({ longFrames: 15 }), { ...opts, cfg: cfg({}) });
    assert.equal(spikes(m).status, 'warn');
  });

  test('software WebGL downgrades failure to warning: an environment effect', () => {
    const stall = raw({ work: Array(13).fill(0.03), frames: 13, longFrames: 13, times: Array(13).fill(300) });
    const m = computeMetrics(stall, { ...opts, cfg: { name: 'T', renderer: 'webgl', budgets: {} }, headless: true });
    assert.equal(m.softwareGl, true);
    assert.equal(spikes(m).status, 'warn');
  });

  test('stalls are visible even without game frames; they use probe frames', () => {
    // Otherwise the only detector for work OUTSIDE rAF would be disabled for
    // the very games doing all their work there.
    const onDemand = { name: 'T', renderer: '2d', renderMode: 'on-demand', budgets: {} };
    const stalling = raw({ work: Array(60).fill(0), frames: 60, gameFrames: 0, paintFrames: 0, longFrames: 40, times: Array(60).fill(300) });
    const m = computeMetrics(stalling, { ...opts, seconds: 3, cfg: onDemand, pixelChange: 0 });

    assert.equal(m.checks.find((c) => c.name === 'frame-work'), undefined, 'no frame cost exists');
    assert.equal(spikes(m).status, 'fail', 'but stalls exist and must be reported');
    assert.equal(m.verdict, 'fail');
  });

  test('busy ratio is named honestly: time inside rAF, not the whole thread', () => {
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}) });
    assert.match(m.checks.find((c) => c.name === 'frame-work').detail, /inside rAF/);
  });
});

describe('draw-call counter did not work', () => {
  test('zero calls during live rendering fail rather than pass the budget', () => {
    // 2D-canvas with a drawCalls budget: a gate that cannot fail,
    // is useless and pretends that GPU load was measured.
    const m = computeMetrics(raw({ draws: Array(100).fill(0), drawsMax: 0, drawsTotal: 0 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    const dc = m.checks.find((c) => c.name === 'draw-calls');
    assert.equal(dc.status, 'fail');
    assert.match(dc.detail, /draw-call counter captured no work/);
  });

  test('without live rendering the counter is not judged; sample already fails sample', () => {
    const m = computeMetrics(raw({ work: [], draws: [], drawsMax: 0, frames: 0, gameFrames: 0, times: [] }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.checks.find((c) => c.name === 'draw-calls'), undefined,
      'without frames there is neither GPU load evidence nor a reason to claim it');
  });
});

describe('measurement duration', () => {
  for (const bad of [0, -1, NaN, Infinity, 'eight']) {
    test(`seconds=${String(bad)} is rejected before browser launch`, async () => {
      await assert.rejects(
        () => probe({ name: 'T', dir: '/tmp/nonexistent', budgets: {} }, { seconds: bad }),
        /positive number/,
      );
    });
  }

  test('valid duration proceeds past validation', async () => {
    // Ensure validation does not reject valid values: the config fails later.
    await assert.rejects(
      () => probe({ name: 'T', dir: '/tmp/nonexistent', budgets: {}, adapterFile: '/tmp/missing-adapter.mjs' }, { seconds: 3 }),
      /Adapter not found/,
    );
  });
});

describe('measurement viewport', () => {
  test('explicit flag overrides the scenario', () => {
    assert.equal(resolveViewport('desktop', { viewport: 'phone' }, { viewport: 'portrait' }), 'desktop');
  });

  test('scenario overrides config: phone is the scene being measured', () => {
    assert.equal(resolveViewport(null, { viewport: 'phone' }, { viewport: 'portrait' }), 'phone');
  });

  test('scenario without viewport preserves config', () => {
    assert.equal(resolveViewport(null, { name: 'peak' }, { viewport: 'portrait' }), 'portrait');
  });

  test('no scenario or config defaults to desktop', () => {
    assert.equal(resolveViewport(null, null, {}), 'desktop');
  });
});

describe('scene preparation', () => {
  /** Stub page: expect runs as an ordinary function, without a browser. */
  const stubPage = () => ({
    evaluated: 0,
    async evaluate(fn, arg) { this.evaluated++; return typeof fn === 'function' ? fn(arg) : true; },
    async waitForTimeout() {},
  });

  const step = (ok, msg) => ({ expect: { fn: () => ok, msg } });

  test('checks accumulate in one array instead of being lost between steps', async () => {
    const checks = await prepareScene(stubPage(), { name: 'peak', steps: [step(true, 'first'), step(true, 'second')] }, {});
    assert.equal(checks.length, 2, 'previously each step received its own empty array');
    assert.deepEqual(checks.map((c) => c.status), ['pass', 'pass']);
  });

  test('false expect aborts measurement and identifies the step', async () => {
    const sc = { name: 'storm-peak', steps: [step(true, 'first'), step(false, 'storm enabled')] };
    await assert.rejects(() => prepareScene(stubPage(), sc, {}), /storm-peak.*step 2.*storm enabled/s);
  });

  test('steps after failure are not executed', async () => {
    const page = stubPage();
    const sc = {
      name: 'peak',
      steps: [step(false, 'scene ready'), { expect: { fn: () => { throw new Error('must not reach here'); }, msg: 'third' } }],
    };
    await assert.rejects(() => prepareScene(page, sc, {}), /not prepared/);
    assert.equal(page.evaluated, 1, 'stops at the first failure');
  });

  test('scenario without steps does not fail', async () => {
    const checks = await prepareScene(stubPage(), { name: 'empty' }, {});
    assert.deepEqual(checks, []);
  });

  test('expect, returning a non-boolean is a broken assertion, not a pass', async () => {
    // `[...document.querySelectorAll('.enemy')]` — a natural assertion for
    // enemies spawned; an empty array is truthy, so an empty scene passed.
    const sc = { name: 'peak', steps: [{ expect: { fn: () => [], msg: 'enemies spawned' } }] };
    await assert.rejects(() => prepareScene(stubPage(), sc, {}), /returned \[\] instead of true\/false/);
  });

  test('an object instead of a boolean also fails', async () => {
    const sc = { name: 'peak', steps: [{ expect: { fn: () => ({ ok: false, why: 'empty' }), msg: 'scene ready' } }] };
    await assert.rejects(() => prepareScene(stubPage(), sc, {}), /instead of true\/false/);
  });
});
