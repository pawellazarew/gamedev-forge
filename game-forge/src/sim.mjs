import path from 'node:path';
import { boot, loadAdapter } from './harness.mjs';
import { runDir, linkLatest, writeJson, appendJsonl, color } from './util.mjs';

/** Batch simulation runs bots hundreds of times without rendering or real time.
 * A single manual run cannot distinguish difficulty from bad luck.
 * The entire loop runs inside the page: a Node/browser round trip costs about
 * 1 ms per frame, turning 10,000 frames into 10 seconds instead of 30 ms. */
export async function simulate(cfg, opts = {}) {
  const {
    runs = 60,
    bots = null,
    maxTicks = 60 * 60 * 10, // 10 game minutes at 60 fps
    sampleEvery = 60,
    seed0 = 1000,
    params = {},
    stamp,
    batch = 8,
  } = opts;

  const adapter = await loadAdapter(cfg);
  if (!adapter) throw new Error(`sim requires an adapter: set adapter in forge.config.mjs (see adapters/ADAPTER.md)`);

  const ctx = await boot(cfg, { viewport: cfg.viewport, seed: seed0, adapter, shell: true });
  const dir = runDir(cfg.dir, 'sim', stamp);
  const jsonl = path.join(dir, 'runs.jsonl');

  try {
    // Ticks per game second: usually 60 for an arcade, but 1 for an idle game.
    // Otherwise four hours of gameplay can be printed as four minutes.
    const tickRate = adapter.tickRate ?? 60;
    const botNames = bots || await ctx.page.evaluate(() => Object.keys(window.__FORGE__.bots || {}));
    if (!botNames.length) throw new Error('The adapter did not define any bots (__FORGE__.bots)');

    // Pause rAF: rendering consumes about 90% of the time and does not affect logic.
    await ctx.page.evaluate(() => { window.__forgeRafPaused = true; });

    const t0 = Date.now();
    const all = [];
    for (const bot of botNames) {
      for (let i = 0; i < runs; i += batch) {
        const n = Math.min(batch, runs - i);
        const seeds = Array.from({ length: n }, (_, k) => seed0 + i + k);
        const chunk = await ctx.page.evaluate(runBatch, { bot, seeds, maxTicks, sampleEvery, params });
        chunk.forEach((r) => { r.bot = bot; r.seconds = +(r.ticks / tickRate).toFixed(1); });
        appendJsonl(jsonl, chunk);
        all.push(...chunk);
        process.stdout.write(`\r  ${bot}: ${Math.min(i + n, runs)}/${runs} runs`);
      }
      process.stdout.write('\n');
    }
    const wallMs = Date.now() - t0;

    const meta = {
      game: cfg.name,
      runs, bots: botNames, maxTicks, sampleEvery, seed0, params, tickRate,
      totalRuns: all.length,
      totalTicks: all.reduce((a, r) => a + r.ticks, 0),
      wallMs,
      ticksPerSecond: Math.round(all.reduce((a, r) => a + r.ticks, 0) / (wallMs / 1000)),
      gameSecondsSimulated: Math.round(all.reduce((a, r) => a + r.ticks, 0) / tickRate),
      jsonl,
      errors: ctx.errors().slice(0, 20),
    };
    writeJson(path.join(dir, 'sim.json'), meta);
    linkLatest(cfg.dir, 'sim', dir);
    return { meta, runs: all, dir };
  } finally {
    await ctx.dispose();
  }
}

/** Runner body, serialized into the page. All dependencies must come through
 * the argument rather than external references. */
function runBatch({ bot, seeds, maxTicks, sampleEvery, params }) {
  const api = window.__FORGE__;
  const policy = api.bots[bot];
  if (!policy) throw new Error(`Bot "${bot}" is not defined by the adapter`);
  const out = [];

  for (const seed of seeds) {
    window.__forgeReseed?.(seed);
    api.start({ seed, ...params });
    const samples = [];
    let ticks = 0;
    let state = api.state();
    const memory = {}; // policy memory persists between frames
    let lastAction = null;
    let lastOk = null; // whether the previous action succeeded;
                       // otherwise the policy may repeat an action it cannot afford forever

    while (ticks < maxTicks && !state.over) {
      const input = policy(state, { ...params, seed, memory, tick: ticks, lastAction, lastOk });
      if (input !== undefined && input !== null) {
        lastOk = api.act(input) !== false;
        lastAction = input;
      }
      api.tick(1);
      ticks++;
      state = api.state();
      if (sampleEvery && ticks % sampleEvery === 0) {
        samples.push({ t: ticks, ...(api.sample ? api.sample() : state) });
      }
    }

    out.push({
      seed,
      ticks,
      seconds: +(ticks / 60).toFixed(1),
      timedOut: ticks >= maxTicks && !state.over,
      final: state,
      events: api.events ? api.events() : [],
      samples,
    });
  }
  return out;
}

export function printSim(meta) {
  console.log(color.b(`\n${meta.game} — sim`));
  console.log(`  runs: ${meta.totalRuns} (${meta.bots.join(', ')})`);
  const gameHours = (meta.gameSecondsSimulated / 3600).toFixed(1);
  console.log(`  game ticks: ${meta.totalTicks.toLocaleString('en')} in ${(meta.wallMs / 1000).toFixed(1)}s ` +
    color.dim(`(${gameHours} h of game time, ×${Math.round(meta.ticksPerSecond / meta.tickRate).toLocaleString('en')} realtime)`));
  if (meta.errors.length) console.log(color.warn(`  console errors: ${meta.errors.length}`));
  console.log(color.dim(`  raw data: ${meta.jsonl}`));
}
