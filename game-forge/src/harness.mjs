import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from './server.mjs';
import { launch, newPage, viewport as viewportPreset } from './browser.mjs';
import { normalizeHittable } from './hittest.mjs';

/** Game config: <gameDir>/forge.config.mjs. The universal shots/probe/play layer
 * works without an adapter; simulation requires one. root/entry identify the build. */
const DEFAULTS = {
  name: 'game',
  root: '.',
  entry: 'index.html',
  viewport: 'desktop',
  renderer: '2d',        // '2d' | 'webgl' controls browser launch flags
  // continuous redraws every frame (arcade/action games).
  // on-demand draws on events (turn-based or Wordle-like games); no drawing
  // for three seconds can be normal in that mode.
  renderMode: 'continuous',
  // Choose the game canvas explicitly or use the largest visible canvas.
  // Indicators and preloaders may appear first in DOM order.
  canvasSelector: null,
  adapter: null,
  scenarios: null,
  references: 'forge/references',
  // Controls a real player must reach: selectors or { selectors, viewports, setup };
  // see hittest.mjs.
  hittable: null,
  budgets: { frameMs: 16.7, errors: 0, bundleKb: 8000, loadMs: 3000 },
};

export async function loadConfig(gameDir) {
  const dir = path.resolve(gameDir);
  const file = path.join(dir, 'forge.config.mjs');
  if (!fs.existsSync(file)) {
    throw new Error(
      `No forge.config.mjs in ${dir}\n` +
      `Create it with: node tools/game-forge/bin/forge.mjs init ${gameDir}`,
    );
  }
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  const cfg = { ...DEFAULTS, ...mod.default };
  // A renderMode typo must not silently re-enable the dead-render gate
  // when the game author opted out.
  if (!['continuous', 'on-demand'].includes(cfg.renderMode)) {
    throw new Error(`renderMode: "${cfg.renderMode}" — only supported values are 'continuous' and 'on-demand'`);
  }
  cfg.budgets = { ...DEFAULTS.budgets, ...(mod.default.budgets || {}) };
  cfg.hittable = normalizeHittable(cfg.hittable);
  cfg.dir = dir;
  cfg.rootDir = path.resolve(dir, cfg.root);
  cfg.referencesDir = path.resolve(dir, cfg.references);
  cfg.adapterFile = cfg.adapter ? path.resolve(dir, cfg.adapter) : null;
  cfg.scenariosFile = cfg.scenarios ? path.resolve(dir, cfg.scenarios) : null;
  return cfg;
}

/** Distinguish missing adapters from broken ones. A broken adapter must throw
 * rather than look like a game without simulation and make all skip checks. */
export async function loadAdapter(cfg) {
  if (!cfg.adapterFile) return null;
  if (!fs.existsSync(cfg.adapterFile)) throw new Error(`Adapter not found: ${cfg.adapterFile}`);
  const mod = await import(pathToFileURL(cfg.adapterFile).href + `?t=${Date.now()}`);
  const a = mod.default || mod;
  if (typeof a.install !== 'function') {
    throw new Error(`Adapter ${cfg.adapterFile} must export install(); see adapters/ADAPTER.md`);
  }
  return a;
}

export async function loadScenarios(cfg) {
  if (!cfg.scenariosFile || !fs.existsSync(cfg.scenariosFile)) return [];
  const mod = await import(pathToFileURL(cfg.scenariosFile).href + `?t=${Date.now()}`);
  return mod.default || [];
}

/** Complete harness: server, browser and game page, with dispose for cleanup. */
export async function boot(cfg, opts = {}) {
  const { viewport = cfg.viewport, headless = true, shell = false, seed = 1, adapter = null } = opts;
  // Validate viewport names before starting anything. Otherwise a typo can fail
  // newPage after launching the server/browser and leave both running.
  viewportPreset(viewport);
  const server = await serve(cfg.rootDir);
  // Software WebGL is only for headless mode, where hardware rendering may show
  // a black frame. Headed mode must retain its actual GPU path.
  const browser = await launch({ headless, shell, swiftshader: headless && cfg.renderer === 'webgl' });
  const page = await newPage(browser, viewport);

  // Install determinism before loading the game so the first Math.random is seeded.
  await page.addInitScript(makePreload(), { seed });
  if (adapter?.preload) await page.addInitScript(adapter.preload, { seed });

  const url = `${server.url}/${cfg.entry}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  const loadMs = Date.now() - t0;

  if (adapter?.install) {
    await page.evaluate(adapter.install);
    await page.waitForFunction(() => window.__FORGE__ && window.__FORGE__.ready !== false, null, { timeout: 15000 });
  }

  return {
    server, browser, page, url, loadMs,
    errors: () => page.__forgeErrors,
    dispose: async () => { await browser.close().catch(() => {}); await server.close().catch(() => {}); },
  };
}

/** Injected before page load: seed Math.random to make runs comparable and
 * balance changes verifiable, and expose rAF pause for render-free simulation. */
function makePreload() {
  return ({ seed }) => {
    let s = (seed >>> 0) || 1;
    const rnd = () => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    Math.random = rnd;
    window.__forgeReseed = (n) => { s = (n >>> 0) || 1; };

    const rafReal = window.requestAnimationFrame.bind(window);
    window.__forgeRafPaused = false;
    const queue = [];

    /** Time each game rAF callback. With vsync, intervals between frames simply
     * match the display period (8.3 ms at 120 Hz); actual work must be timed
     * inside the callback. */
    const timed = (cb) => (ts) => {
      const f = window.__forgeFrames;
      const t0 = performance.now();
      // inCb means a game callback is running. Drawing from setInterval, handlers
      // or an unrelated overlay must not count as evidence of a live game loop.
      if (f) f.inCb++;
      const leave = () => { if (f && f.inCb > 0) f.inCb--; };
      let async = false;
      try {
        const out = cb(ts);
        // An async rAF callback can draw after its first await. Keep the callback
        // open until its promise settles rather than declaring it non-rendering.
        if (out && typeof out.then === 'function') { async = true; out.then(leave, leave); }
      } finally {
        // Accumulate pending work and finalize it in tickProbe: two 10 ms callbacks
        // in one frame cost 20 ms, not two separate 10 ms frames. cbPending counts
        // invocations separately from drawing activity.
        if (f) { f.pending += performance.now() - t0; f.cbPending++; }
        if (!async) leave();
      }
    };

    window.requestAnimationFrame = (cb) => {
      if (window.__forgeRafPaused) { queue.push(cb); return -1; }
      return rafReal(timed(cb));
    };
    window.__forgeRafResume = () => {
      window.__forgeRafPaused = false;
      const pending = queue.splice(0);
      pending.forEach((cb) => rafReal(timed(cb)));
    };

    // Count draw calls per frame: GPU spikes disappear in averages, such as one
    // 600-call frame among frames averaging 7 calls. A game callback is not
    // evidence of drawing: an empty loop can run over a frozen image.
    // Count a painted frame only when a draw originates in a game callback and
    // targets the exact canvas probe screenshots. Offscreen buffers, indicators
    // and helper canvases must not vouch for a dead game canvas.
    // A cached clientWidth visibility check previously misclassified canvases
    // shown after load and opacity:0 canvases. Identity with the screenshot
    // target is unambiguous, avoids layout and matches pixel comparisons.
    const gameCanvas = () => {
      let cv = window.__forgeCanvas;
      // Resolve again only if the canvas was detached and recreated.
      // isConnected reads a property without forcing layout.
      if (!cv || !cv.isConnected) {
        cv = document.querySelector(window.__forgeCanvasSel || 'canvas');
        window.__forgeCanvas = cv;
      }
      return cv;
    };
    // Use a flag, not a count: after a frame is marked, avoid checks on every fillRect.
    const markPaint = (f, cv) => {
      if (!f || !f.inCb || !cv || f.painted) return;
      if (cv === gameCanvas()) f.painted = 1;
      // The game is drawing elsewhere; suggest canvasSelector rather than failing it outright.
      else f.paintedOther = 1;
    };

    window.__forgeDraws = 0;
    for (const proto of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!proto) continue;
      for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const orig = proto.prototype[m];
        if (!orig) continue;
        proto.prototype[m] = function (...args) {
          window.__forgeDraws++;
          const f = window.__forgeFrames;
          // Draw-call counts include all GPU work; paint activity only counts the player-visible canvas.
          if (f) { f.drawsPending++; markPaint(f, this.canvas); }
          return orig.apply(this, args);
        };
      }
    }

    for (const proto of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
      if (!proto) continue;
      for (const m of ['fillRect', 'strokeRect', 'clearRect', 'drawImage', 'fill', 'stroke',
        'fillText', 'strokeText', 'putImageData']) {
        const orig = proto.prototype[m];
        if (!orig) continue;
        proto.prototype[m] = function (...args) {
          markPaint(window.__forgeFrames, this.canvas);
          return orig.apply(this, args);
        };
      }
    }

    // Three distinct values:
    // count: probe frames, even when the game draws nothing.
    // gameFrames: frames containing a game rAF callback.
    // times: frame intervals, the browser cadence, for reference.
    window.__forgeFrames = {
      count: 0, long: 0, times: [], last: 0, startedAt: 0,
      work: [], workTotal: 0, workMax: 0, pending: 0,
      gameFrames: 0, cbPending: 0, paintFrames: 0, painted: 0, inCb: 0, lastPaintAt: 0,
        otherPaintFrames: 0, paintedOther: 0,
      draws: [], drawsPending: 0, drawsMax: 0,
    };
    // tickProbe is registered first and runs before game callbacks,
    // so it closes the work accumulated for the previous frame.
    const tickProbe = (ts) => {
      const f = window.__forgeFrames;
      if (!f.startedAt) f.startedAt = performance.now();
      if (f.last) {
        const dt = ts - f.last;
        f.count++;
        if (dt > 50) f.long++;
        if (f.times.length < 4000) f.times.push(dt);

        const frameWork = f.pending;
        f.pending = 0;
        f.workTotal += frameWork;
        if (f.work.length < 4000) f.work.push(frameWork);
        if (frameWork > f.workMax) f.workMax = frameWork;

        // Count a game frame only if its callback ran.
        const cbs = f.cbPending;
        f.cbPending = 0;
        if (cbs > 0) f.gameFrames++;

        const frameDraws = f.drawsPending;
        f.drawsPending = 0;
        // Both 2D and WebGL hooks set one paint flag. Reset it each frame so one
        // draw cannot mark all future frames as painted. lastPaintAt distinguishes
        // occasional redraws from rendering that ran and then stopped.
        if (f.painted) { f.paintFrames++; f.lastPaintAt = f.count; }
        if (f.paintedOther) f.otherPaintFrames++;
        f.painted = 0;
        f.paintedOther = 0;
        if (f.draws.length < 4000) f.draws.push(frameDraws);
        if (frameDraws > f.drawsMax) f.drawsMax = frameDraws;
      }
      f.last = ts;
      rafReal(tickProbe);
    };
    rafReal(tickProbe);
    window.__forgeResetFrames = () => {
      window.__forgeFrames = {
        count: 0, long: 0, times: [], last: 0, startedAt: performance.now(),
        work: [], workTotal: 0, workMax: 0, pending: 0,
        gameFrames: 0, cbPending: 0, paintFrames: 0, painted: 0, inCb: 0, lastPaintAt: 0,
        otherPaintFrames: 0, paintedOther: 0,
        draws: [], drawsPending: 0, drawsMax: 0,
      };
      window.__forgeDraws = 0;
    };
  };
}
