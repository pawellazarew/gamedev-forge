import path from 'node:path';
import { boot, loadAdapter, loadScenarios } from './harness.mjs';
import { applyStep } from './scenario.mjs';
import { resolveViewport } from './browser.mjs';
import { hittableChecks, hittableFor, hittableSummary, settleOf } from './hittest.mjs';
import { frameStats, pixelDiffRatio } from './png.mjs';
import { runDir, linkLatest, writeJson, mean, median, percentile, filterNoise, color, verdictMark } from './util.mjs';

/** Below this frame count there is no meaningful performance sample. */
export const MIN_FRAMES = 5;
/** Enough frames to produce a number, but not enough to trust it. */
export const THIN_FRAMES = 20;
/** Below this painted-frame fraction, the game draws intermittently rather than continuously. */
export const MIN_PAINT_SHARE = 0.5;
/** Minimum changed-pixel fraction for a moving image. Frozen fixtures (zombie,
 * ghost-backbuffer, dirty-render) and WebGL redraws of identical images
 * measure exactly 0; live games measure 0.0006 (quiet Phaser scene) to 0.026.
 * Place the threshold between them, closer to zero: a false movement signal
 * is safer than incorrectly failing a healthy game. */
export const PIXEL_CHANGE_EPS = 0.0001;
/** Startup deadline: a stuck start must fail rather than hang CI. */
const START_TIMEOUT_MS = 30000;

/** Promise deadline wrapper: page.evaluate has no built-in timeout. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

/** Automated measurements: main-thread frame work, peak draw calls, errors,
 * size, memory and dead-frame signals. Works without a game adapter. */
export async function probe(cfg, opts = {}) {
  const { seconds = 8, seed = 1, stamp, headless = true, scenario = null } = opts;
  // A zero-length window used to yield zero work and a green verdict, passing
  // any game. Validate before launching the browser so a typo fails cheaply.
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--seconds must be a positive number, got «${seconds}»: a zero-length window measures nothing`);
  }
  // Propagate adapter-loading failures. A broken adapter must not look absent.
  const adapter = cfg.adapterFile ? await loadAdapter(cfg) : null;

  // Resolve scenarios before browser launch because viewport is fixed when
  // the context is created. A phone scene in a desktop window is a different scene.
  const sc = scenario ? await findScenario(cfg, scenario) : null;
  const viewport = resolveViewport(opts.viewport, sc, cfg);

  // headless:false preserves the real GPU path for meaningful WebGL investigation.
  const ctx = await boot(cfg, { viewport, seed, adapter, headless });

  try {
    let scenePath = null;
    let hitChecks = [];
    if (sc) {
      // Measure a demanding scene, not the opening room. --scenario storm-peak
      // runs ordinary scenario steps without screenshots before enabling counters.
      // An overlay found during these steps is a finding, not failed preparation.
      hitChecks = (await prepareScene(ctx.page, sc, cfg)).filter((c) => c.kind === 'hittable');
      scenePath = sc.name;
      // Check hit targets at the same scenario boundary as play, before measuring.
      // After eight game seconds an end screen or advertisement could change the
      // result. The check restores scrolling and finishes waiting before counters reset.
      const sels = hittableFor(sc, cfg);
      if (sels.length) hitChecks.push(...await hittableChecks(ctx.page, sels, settleOf(cfg)));
    } else if (adapter?.autostart !== false) {
      // Advance to gameplay: title screens are always cheap. Propagate start()
      // errors; otherwise the title screen would be measured as the game. Discard
      // the return value because unserializable results can break evaluate.
      try {
        // async/await are required: dropping the startup promise returns immediately,
        // measures the title screen and swallows startup failures. Still discard the
        // result to avoid serialization failures.
        const started = await withTimeout(
          ctx.page.evaluate(async () => {
            const api = window.__FORGE__;
            if (!api) return 'missing __FORGE__';
            if (typeof api.start !== 'function') return 'missing start()';
            await api.start({ mode: 0 });
            return null;
          }),
          START_TIMEOUT_MS,
          `start() did not finish within ${START_TIMEOUT_MS / 1000} s`,
        );
        // A connected adapter must expose start(). A method-name typo must not
        // silently cause measurement of the title screen.
        if (adapter && started) throw new Error(`${started} — the adapter must define window.__FORGE__.start()`);
      } catch (err) {
        throw new Error(`__FORGE__.start() failed: ${String(err?.message || err).slice(0, 300)}. `
          + 'Measurement cancelled: probe would measure the title screen instead of gameplay.');
      }
    }

    // Create the run directory after scene preparation; an aborted measurement
    // gets a separate failed artifact with its reason.
    const dir = runDir(cfg.dir, 'probe', stamp);

    // Take a before screenshot in case the game bypasses instrumented APIs
    // (worker, WebGPU, DOM/CSS): changing pixels can prove activity despite no
    // observed draw commands. Capture before resetting counters so screenshot
    // overhead stays outside the measurement window.
    // Capture the game canvas, not a neighboring DOM counter. Resolve the canvas
    // once and pass that exact element into the page so paint counts and pixel
    // comparison cannot diverge. Playwright selectors also pierce shadow DOM,
    // unlike document.querySelector.
    const selector = cfg.canvasSelector || sc?.selector || null;
    const canvasEl = await resolveCanvas(ctx.page, selector);
    if (canvasEl) await canvasEl.evaluate((node) => { window.__forgeCanvas = node; });

    const before = await shoot(canvasEl, ctx.page);

    await ctx.page.evaluate(() => window.__forgeResetFrames?.());
    await ctx.page.waitForTimeout(seconds * 1000);

    const raw = await ctx.page.evaluate(() => {
      const f = window.__forgeFrames || {};
      const mem = performance.memory ? performance.memory.usedJSHeapSize : null;
      return {
        frames: f.count || 0, gameFrames: f.gameFrames || 0, paintFrames: f.paintFrames || 0,
        lastPaintAt: f.lastPaintAt || 0, otherPaintFrames: f.otherPaintFrames || 0,
        longFrames: f.long || 0, times: (f.times || []).slice(0, 4000),
        work: (f.work || []).slice(0, 4000), workTotal: f.workTotal || 0, workMax: f.workMax || 0,
        draws: (f.draws || []).slice(0, 4000), drawsMax: f.drawsMax || 0, drawsTotal: window.__forgeDraws || 0,
        elapsedMs: performance.now() - (f.startedAt || performance.now()),
        heapBytes: mem,
        dpr: window.devicePixelRatio,
        state: window.__FORGE__?.state?.() ?? null,
      };
    });

    // Analyze the screenshot, not an in-page read: WebGL buffers may already be cleared.
    const framePath = path.join(dir, 'frame.png');
    const shot = await ctx.page.screenshot({ path: framePath });
    let canvasStats = null;
    try {
      canvasStats = frameStats(shot);
    } catch (err) {
      canvasStats = { error: String(err.message || err) };
    }

    // Use a changed-pixel ratio, not byte equality, so a blinking counter cannot
    // make a frozen game look alive.
    let pixelChange = null;
    try {
      const after = await shoot(canvasEl, ctx.page);
      pixelChange = +pixelDiffRatio(before, after).toFixed(4);
      // Image-content checks also use the game canvas; surrounding page colors
      // must not make a black game canvas pass.
      canvasStats = frameStats(after);
    } catch { /* Comparison unavailable means unknown, not frozen. */ }

    // An overlay is a finding, not a failed scene; measured metrics remain valid.
    const extraChecks = hitChecks.length ? [hittableSummary(hitChecks)] : [];

    const metrics = computeMetrics(raw, {
      cfg, viewport, seconds, scenario: scenePath, headless,
      loadMs: ctx.loadMs,
      bundleKb: Math.round(ctx.server.bytes() / 1024),
      errors: filterNoise(ctx.errors()),
      canvas: canvasStats,
      pixelChange,
      extraChecks,
    });

    writeJson(path.join(dir, 'probe.json'), metrics);
    linkLatest(cfg.dir, 'probe', dir);
    return { metrics, dir };
  } catch (err) {
    // Any interruption (scene, start, screenshot or browser failure) must leave
    // a failed artifact. Otherwise latest-probe still points at an earlier
    // passing run and report/critique misrepresent stale numbers as current.
    writeAbort(cfg, { stamp, ctx, viewport, seconds, scenario: sc?.name ?? null, headless, reason: String(err?.message || err) });
    throw err;
  } finally {
    await ctx.dispose();
  }
}

/** Empty counters state explicitly that no measurement was obtained. */
// paintFrames:null means unmeasured. Zero would assert that rendering did
// not happen, which an aborted measurement cannot establish.
const NO_MEASUREMENT = {
  frames: 0, longFrames: 0, times: [], work: [], workTotal: 0, workMax: 0,
  gameFrames: 0, paintFrames: null, otherPaintFrames: null, draws: [], drawsMax: 0, drawsTotal: 0,
  elapsedMs: 0, heapBytes: null, state: null,
};

/** Aborted-measurement artifact: a complete failed probe.json. This helper
 * must not throw and replace the original error it was called to record. */
function writeAbort(cfg, { stamp, ctx, viewport, seconds, scenario, headless, reason }) {
  try {
    const metrics = computeMetrics(NO_MEASUREMENT, {
      cfg, viewport, seconds, scenario, headless,
      loadMs: ctx.loadMs,
      bundleKb: Math.round(ctx.server.bytes() / 1024),
      errors: filterNoise(ctx.errors()),
    });
    metrics.checks.unshift({ name: 'scene', status: 'fail', detail: reason });
    metrics.verdict = 'fail';
    const dir = runDir(cfg.dir, 'probe', stamp);
    writeJson(path.join(dir, 'probe.json'), metrics);
    linkLatest(cfg.dir, 'probe', dir);
    return dir;
  } catch {
    return null;
  }
}

/** Use an explicit game canvas selector or the largest visible canvas. The
 * first DOM canvas might be an indicator/preloader and steal the paint count. */
async function resolveCanvas(page, selector) {
  const els = await page.$$(selector || 'canvas');
  if (els.length <= 1) return els[0] || null;
  let best = null, bestArea = -1;
  for (const el of els) {
    const area = await el.evaluate((e) => e.clientWidth * e.clientHeight).catch(() => 0);
    if (area > bestArea) { bestArea = area; best = el; }
  }
  return best;
}

/** Screenshot the canvas, or the full page if it is absent/hidden. Bound the
 * wait so a hidden canvas cannot spend 30 seconds waiting for visibility
 * and fail the run for an unrelated reason. */
async function shoot(el, page) {
  if (el) {
    try {
      return await el.screenshot({ timeout: 2000 });
    } catch { /* Hidden, recreated or detached; capture the page instead. */ }
  }
  return page.screenshot();
}

async function findScenario(cfg, name) {
  const all = await loadScenarios(cfg);
  const sc = all.find((s) => s.name === name);
  if (!sc) {
    throw new Error(`Scenario "${name}" not found. Available: ${all.map((s) => s.name).join(', ') || '(none)'}`);
  }
  return sc;
}

/** Prepare the target scene using the same scenario steps. A failed expect
 * cancels measurement: losing each step's checks previously let probe
 * measure an unprepared scene and report misleading passing numbers. */
export async function prepareScene(page, sc, cfg) {
  const checks = [];
  for (const [i, step] of (sc.steps || []).entries()) {
    await applyStep(page, step, { sc, i, shots: [], checks, cfg, skipShots: true });
    // A failed hittable step does not cancel preparation: the scene exists but
    // a control is covered. Report it through a separate probe check.
    const failed = checks.find((c) => c.status === 'fail' && c.kind !== 'hittable');
    if (failed) {
      throw new Error(
        `Scene «${sc.name}» was not prepared: step ${i + 1}, «${failed.name}» — ${failed.detail}. ` +
        'Measurement cancelled: measuring an unprepared scene is meaningless.',
      );
    }
  }
  return checks;
}

/** Pure conversion from page counters to metrics and verdict, separated from
 * the browser so tests need not launch a game. */
export function computeMetrics(raw, {
  cfg, viewport, seconds, scenario = null, headless = true,
  loadMs = 0, bundleKb = 0, errors = [], canvas = null, pixelChange = null, extraChecks = [],
}) {
  const budgetMs = cfg.budgets?.frameMs ?? 16.7;

  // The main metric is actual computation/drawing inside game callbacks.
  // Vsync intervals follow the display period (8.3 ms at 120 Hz) regardless of work.
  const works = (raw.work || []).filter((t) => t >= 0 && t < 5000);
  // Sample size is part of the result: without it, zero measured work is
  // indistinguishable from a measurement that never happened.
  const workSamples = works.length;
  const frameWorkMs = works.length ? +median(works).toFixed(2) : 0;
  const frameWorkP99Ms = works.length ? +percentile(works, 99).toFixed(2) : 0;
  const frameWorkMaxMs = +(raw.workMax || 0).toFixed(2);
  // Compute headroom from the configured budget. For an 8 ms 3D budget,
  // headroom relative to 16.7 ms would be invented reassurance.
  const headroom = frameWorkMs ? +(budgetMs / frameWorkMs).toFixed(2) : 0;
  const mainThreadBusy = raw.elapsedMs ? +(raw.workTotal / raw.elapsedMs).toFixed(3) : 0;

  // Cadence is reference information: presentation rate, not frame cost.
  const dts = (raw.times || []).filter((t) => t > 0 && t < 1000);
  const frameSamples = dts.length;
  const frameIntervalMs = dts.length ? +median(dts).toFixed(2) : 0;
  const fps = dts.length ? 1000 / mean(dts) : 0;
  const fps1pctLow = dts.length ? 1000 / percentile(dts, 99) : 0;

  // Count draw calls per frame and gate on the peak, which causes the stall
  // and exceeds the GPU budget even when average load is low.
  const draws = raw.draws || [];
  const drawCallsMedian = draws.length ? Math.round(median(draws)) : 0;
  const drawCallsP99 = draws.length ? Math.round(percentile(draws, 99)) : 0;
  const drawCallsMax = raw.drawsMax || 0;
  const drawCallsAvg = raw.frames ? Math.round((raw.drawsTotal || 0) / raw.frames) : 0;

  const metrics = {
    game: cfg.name,
    viewport,
    seconds,
    scenario,
    loadMs,
    bundleKb,
    frameWorkMs,
    frameWorkP99Ms,
    frameWorkMaxMs,
    mainThreadBusy,
    headroom,
    budgetMs,
    frameIntervalMs,
    fpsAvg: +fps.toFixed(1),
    fps1pctLow: +fps1pctLow.toFixed(1),
    frames: raw.frames,
    // Probe and game frame counts diverge when it matters: a dead game loop
    // can still produce dozens of probe frames.
    gameFrames: raw.gameFrames ?? null,
    // Frames with actual paint commands: a live rAF loop alone proves no drawing.
    paintFrames: raw.paintFrames ?? null,
    // The last probe frame with drawing distinguishes sparse redraws from
    // a renderer that ran and then stopped.
    lastPaintAt: raw.lastPaintAt ?? null,
    // Drawing on another canvas suggests the probe target may be wrong, not a failure by itself.
    otherPaintFrames: raw.otherPaintFrames ?? null,
    // Canvas pixel changes over the window. null means unknown comparison,
    // not a frozen image.
    pixelChange,
    renderMode: cfg.renderMode ?? 'continuous',
    workSamples,
    frameSamples,
    longFrames: raw.longFrames,
    longFrameRatio: raw.frames ? +(raw.longFrames / raw.frames).toFixed(4) : 0,
    drawCallsMedian,
    drawCallsP99,
    drawCallsMax,
    drawCallsAvg,
    heapMb: raw.heapBytes ? +(raw.heapBytes / 1048576).toFixed(1) : null,
    canvas,
    // Headless WebGL uses SwiftShader; frame metrics indicate relative trends,
    // not hardware GPU speed.
    softwareGl: cfg.renderer === 'webgl' && headless,
    headless,
    errors,
    errorCount: errors.length,
    state: raw.state ?? null,
  };

  // extraChecks cover non-frame findings such as end-of-scenario hit targets.
  // Any failed extra check must affect the one overall probe verdict.
  metrics.checks = [...evaluateBudgets(metrics, cfg.budgets || {}), ...extraChecks];
  metrics.verdict = metrics.checks.some((c) => c.status === 'fail') ? 'fail'
    : metrics.checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return metrics;
}

/** Three sample-failure causes require different fixes. Blaming a short
 * --seconds window for a dead rendering loop would send the user astray. */
function sampleFailure(frames, gameFrames, workSamples, seconds) {
  if (frames < MIN_FRAMES) {
    return `${frames} probe frames in ${seconds ?? '?'} s; the measurement window is nearly zero `
      + 'or the tab is frozen: increase --seconds';
  }
  if (gameFrames === 0) {
    return `the game did not draw a single frame during ${frames} probe frames; the rendering loop never started, `
      + 'is broken or does not use requestAnimationFrame (outside the scope of this probe)';
  }
  if (workSamples === 0) {
    return `${gameFrames} game frames but no valid work samples; `
      + 'frame instrumentation is broken; the numbers are unreliable';
  }
  return `${gameFrames} game frames out of ${frames} probe frames; need >=${MIN_FRAMES}: `
    + 'the game draws intermittently or the measurement window is too short';
}

export function evaluateBudgets(m, b) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // Validate the measurement first. Empty samples yield zero work/draw calls
  // that pass every budget; this is a measurement failure, not a healthy game.
  // Count game frames rather than tickProbe's own rAF frames, which continue
  // even while the game draws nothing.
  const frames = m.frames || 0;
  const gameFrames = m.gameFrames ?? frames;   // Read old probe.json files without this field using legacy behavior.
  const workSamples = m.workSamples ?? 0;
  const onDemand = m.renderMode === 'on-demand';
  const partial = workSamples > 0 && workSamples < gameFrames;
  const measured = gameFrames >= MIN_FRAMES && workSamples > 0;
  // On-demand games can legitimately have no rAF or drawn frames, as in
  // Wordle. Their frame cost is unmeasured; a failed verdict would falsely
  // claim the functioning game is broken.
  const emptyWindow = frames < MIN_FRAMES;
  // Only a completely absent loop is exempt. One to four game frames imply
  // a loop that started and stopped, a failure under either render mode.
  const pardon = onDemand && !emptyWindow && gameFrames === 0;
  add('sample',
    measured ? ((gameFrames < THIN_FRAMES || partial) ? 'warn' : 'pass')
      : pardon ? 'warn' : 'fail',
    measured
      ? `${gameFrames} game frames out of ${frames} probe frames in ${m.seconds ?? '?'} s`
        + (gameFrames < THIN_FRAMES ? ` — sample below ${THIN_FRAMES} frames; numbers are noisy` : '')
        + (partial ? ` — only ${workSamples} work samples: numbers describe the start of the window, not all of it` : '')
      : pardon
        ? `rendering loop did not run for ${m.seconds ?? '?'} s; frame cost was not measured. `
          + 'renderMode: on-demand; the game draws on events and has nothing to redraw without input'
        : sampleFailure(frames, gameFrames, workSamples, m.seconds));

  // A full stream of empty rAF callbacks can accompany a frozen image. Count
  // frames issuing 2D/WebGL drawing commands. Commands alone are insufficient:
  // workers, WebGPU or DOM/CSS may bypass instrumentation. Missing commands
  // plus unchanged pixels justify failure; changing pixels imply an
  // instrumentation blind spot and should only warn.
  const paintFrames = m.paintFrames ?? null;
  // With no game frames, sample has already explained the absence. Do not
  // claim that its loop is running or infer paint activity.
  if (paintFrames != null && gameFrames > 0) {
    const share = paintFrames / gameFrames;
    // Use a fraction, not an absolute count: five painted frames out of 700
    // indicate rendering that died, not a live game.
    const enoughPaint = paintFrames >= MIN_FRAMES && share >= MIN_PAINT_SHARE;
    const frozen = m.pixelChange != null && m.pixelChange < PIXEL_CHANGE_EPS;
    const pct = `${Math.round(share * 100)}%`;

    // Sparse redraws and rendering that stopped can have the same ratio.
    // A long unpainted tail distinguishes a renderer that died after its first draws.
    const tail = Math.max(MIN_FRAMES, Math.round(frames * 0.25));
    const gap = paintFrames > 0 && m.lastPaintAt != null ? frames - m.lastPaintAt : null;
    const stopped = gap != null && gap > tail;

    // Identical pixels on every redraw can mean a lost blit, an offscreen
    // render or a still scene. Only fail a stopped renderer if it previously
    // painted most frames; otherwise a title animation settling into an input
    // wait would fail, and runner cadence would affect the verdict.
    // Frozen pixels with full drawing activity are not a warning by themselves:
    // game over, pause and quiet scenes can redraw the same image legitimately.
    // The healthy tiny-game fixture does this in a one-second window. Add a
    // text note; missing game-canvas drawing catches a genuinely lost blit.
    const status = paintFrames === 0 ? (!frozen ? 'warn' : onDemand ? 'warn' : 'fail')
      : (stopped && enoughPaint) ? (onDemand ? 'warn' : 'fail')
        : (stopped || !enoughPaint) ? 'warn'
          : 'pass';

    add('render', status,
      paintFrames === 0
        ? (!frozen
          ? `no draw commands observed in ${gameFrames} game frames, but canvas pixels change; `
            + 'the game bypasses 2D/WebGL (worker, WebGPU, DOM/CSS): frame cost was measured, render activity was not'
          : `in ${m.seconds ?? '?'} s the game issued no draw commands and no canvas pixel `
            + `changed (${gameFrames} idle game frames); rendering is dead`
            + (m.otherPaintFrames ? `. However, another canvas was painted in ${m.otherPaintFrames} frames — `
              + 'if the game canvas is different, set canvasSelector in the config' : '')
            + (onDemand ? '. renderMode: on-demand; this is normal for event-driven rendering' : ''))
        : stopped
          ? `rendering stopped: the last draw was ${gap} frames before the end of the window `
            + `(${paintFrames} of ${gameFrames} game frames painted, ${pct})`
            + (enoughPaint ? '' : ' — either rendering died or the screen finished its animation and is waiting for input')
            + (onDemand ? '. renderMode: on-demand; event-driven rendering' : '')
          : paintFrames < MIN_FRAMES
            ? `only ${paintFrames} painted frames; insufficient evidence to assess rendering`
            : !enoughPaint
              ? `only ${paintFrames} of ${gameFrames} game frames were painted (${pct}); the game barely redraws`
              : `${paintFrames} of ${gameFrames} game frames were painted (${pct})`
              + (frozen ? ' — canvas pixels did not change: game over, paused or redrawing the same image' : ''));
  }

  // Frame metrics exist only when frames were measured. Otherwise zero work
  // and draw calls create misleading passing gates beneath a failed sample.
  // Size, load time, errors and image-content checks do not depend on frames.
  const budgetMs = b.frameMs ?? 16.7;
  if (measured) {
    // Software WebGL is much slower than hardware; downgrade its budget failure
    // to a warning and explain the environment limitation.
    const costStatus = m.frameWorkMs <= budgetMs ? 'pass' : m.frameWorkMs <= budgetMs * 1.5 ? 'warn' : 'fail';
    add('frame-work', m.softwareGl && costStatus === 'fail' ? 'warn' : costStatus,
      `${m.frameWorkMs} ms of frame work (budget <=${budgetMs} ms); headroom ×${m.headroom}, ` +
      // Say inside rAF, not main thread: timeouts, event handlers and parsing
      // are excluded. Broader claims would falsely reassure users.
      `busy inside rAF for ${Math.round(m.mainThreadBusy * 100)}% of the time` +
      (m.softwareGl ? ' · software WebGL; compare only against previous runs' : ''));

    const spikeStatus = m.frameWorkP99Ms <= budgetMs * 3 ? 'pass' : m.frameWorkP99Ms <= budgetMs * 6 ? 'warn' : 'fail';
    add('frame-spikes', m.softwareGl && spikeStatus === 'fail' ? 'warn' : spikeStatus,
      `p99 work ${m.frameWorkP99Ms} ms, maximum ${m.frameWorkMaxMs} ms`);
  }

  // Stalls use probe frames and remain measurable without game callbacks.
  // Keep this check even when frame-work metrics are absent: a blocking
  // setInterval is outside rAF work but stretches frame intervals.
  // Cadence cannot be a gate because headless Chromium can cap it at 30 fps;
  // that would measure the harness. The >50 ms frame fraction is independent
  // of this cap: a 33 ms frame is not a 50 ms stall.
  if (frames >= MIN_FRAMES) {
    const ratio = m.longFrameRatio ?? 0;
    const stallStatus = ratio <= 0.02 ? 'pass' : ratio <= 0.2 ? 'warn' : 'fail';
    add('stalls', m.softwareGl && stallStatus === 'fail' ? 'warn' : stallStatus,
      `frames longer than 50 ms: ${m.longFrames}/${frames} (${Math.round(ratio * 100)}%)`
      + (stallStatus !== 'pass' ? ' — the game stalls: work outside rAF or an expensive frame' : ''));
  }

  add('errors', m.errorCount <= (b.errors ?? 0) ? 'pass' : m.errorCount <= (b.errors ?? 0) + 3 ? 'warn' : 'fail',
    m.errorCount ? m.errors.slice(0, 3).map((e) => `${e.kind}: ${e.text}`).join(' | ') : 'clean');

  if (b.bundleKb != null) {
    add('bundle', m.bundleKb <= b.bundleKb ? 'pass' : m.bundleKb <= b.bundleKb * 1.5 ? 'warn' : 'fail',
      `${m.bundleKb} KB downloaded (budget <=${b.bundleKb} KB)`);
  }

  if (b.loadMs != null) {
    add('load', m.loadMs <= b.loadMs ? 'pass' : m.loadMs <= b.loadMs * 2 ? 'warn' : 'fail',
      `${m.loadMs} ms until load (budget <=${b.loadMs} ms)`);
  }

  // Draw calls are the available GPU-load proxy; frameWorkMs measures the
  // main thread only. Gate on the maximum, not mean or p99: one 600-call
  // frame amid a mean of 7 is real GPU work. Even p99 can discard a single
  // heavy frame out of 100, although the player experiences that stall.
  if (measured && b.drawCalls != null) {
    const peak = m.drawCallsMax;
    // Zero draws with active rendering means the counter did not capture work,
    // not that the game met its budget. An impossible-to-fail gate is useless.
    const neverFired = peak === 0 && (m.gameFrames ?? m.frames ?? 0) >= MIN_FRAMES;
    add('draw-calls', neverFired ? 'fail' : peak <= b.drawCalls ? 'pass' : peak <= b.drawCalls * 1.5 ? 'warn' : 'fail',
      neverFired
        ? 'draw-call counter captured no work despite active rendering; the game bypasses WebGL '
          + '(2D canvas, WebGPU or OffscreenCanvas in a worker). The drawCalls budget does not apply'
        : `peak ${peak} draw calls/frame (budget <=${b.drawCalls}), p99 ${m.drawCallsP99}, median ${m.drawCallsMedian}`
          + ' — GPU-load proxy');
  }

  if (m.canvas && !m.canvas.error) {
    const dead = m.canvas.distinctColors <= 2 || m.canvas.maxLum - m.canvas.minLum < 6;
    add('frame-alive', dead ? 'fail' : 'pass',
      `${m.canvas.distinctColors} distinct colors, luminance ${m.canvas.minLum}–${m.canvas.maxLum}`);
  }
  return checks;
}

export function printProbe(m) {
  const scene = m.scenario ? `, scene «${m.scenario}»` : '';
  console.log(color.b(`\n${m.game} — probe (${m.viewport}, ${m.seconds}s${scene})`));
  for (const c of m.checks) console.log(`  ${verdictMark(c.status)} ${c.name.padEnd(13)} ${c.detail}`);
  // Print reference numbers only when backed by measured frames. Zero median
  // and zero cadence without a sample merely look like data.
  if (m.checks.some((c) => c.name === 'frame-work')) {
    console.log(color.dim(`  draw calls: median ${m.drawCallsMedian}, p99 ${m.drawCallsP99}, max ${m.drawCallsMax}` +
      `${m.heapMb ? ` · heap ${m.heapMb} MB` : ''}` +
      `  ·  cadence ${m.frameIntervalMs} ms (${m.fpsAvg} fps); presentation rate, not frame cost`));
  }
}
