import path from 'node:path';
import { boot, loadAdapter } from './harness.mjs';
import { runDir, linkLatest, writeJson, appendJsonl, color } from './util.mjs';

/**
 * Массовая симуляция: бот проходит игру сотни раз без рендера и без реального
 * времени. Это единственный способ увидеть баланс — по одному прохождению
 * руками не отличить «сложно» от «не повезло».
 *
 * Весь цикл крутится ВНУТРИ страницы: round-trip Node↔браузер на каждый кадр
 * стоил бы ~1 мс, то есть 10 000 кадров = 10 секунд вместо 30 мс.
 */
export async function simulate(cfg, opts = {}) {
  const {
    runs = 60,
    bots = null,
    maxTicks = 60 * 60 * 10, // 10 игровых минут при 60 fps
    sampleEvery = 60,
    seed0 = 1000,
    params = {},
    stamp,
    batch = 8,
  } = opts;

  const adapter = await loadAdapter(cfg);
  if (!adapter) throw new Error(`Для sim нужен адаптер: укажи adapter в forge.config.mjs (см. adapters/ADAPTER.md)`);

  const ctx = await boot(cfg, { viewport: cfg.viewport, seed: seed0, adapter, shell: true });
  const dir = runDir(cfg.dir, 'sim', stamp);
  const jsonl = path.join(dir, 'runs.jsonl');

  try {
    // Сколько тиков в игровой секунде: у аркады это кадр (60), у idle-игры —
    // секунда (1). Без этого 4 часа игры печатаются как 4 минуты.
    const tickRate = adapter.tickRate ?? 60;
    const botNames = bots || await ctx.page.evaluate(() => Object.keys(window.__FORGE__.bots || {}));
    if (!botNames.length) throw new Error('Адаптер не объявил ни одного бота (__FORGE__.bots)');

    // rAF выключаем: рендер съедает 90% времени и на логику не влияет.
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
        process.stdout.write(`\r  ${bot}: ${Math.min(i + n, runs)}/${runs} прогонов`);
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

/**
 * Тело раннера. Сериализуется в страницу целиком, поэтому никаких внешних
 * ссылок здесь быть не может — только аргумент.
 */
function runBatch({ bot, seeds, maxTicks, sampleEvery, params }) {
  const api = window.__FORGE__;
  const policy = api.bots[bot];
  if (!policy) throw new Error(`Бот "${bot}" не объявлен адаптером`);
  const out = [];

  for (const seed of seeds) {
    window.__forgeReseed?.(seed);
    api.start({ seed, ...params });
    const samples = [];
    let ticks = 0;
    let state = api.state();
    const memory = {}; // политика может хранить своё между кадрами
    let lastAction = null;
    let lastOk = null; // сработало ли предыдущее действие — иначе политика
                       // будет вечно долбиться в действие, на которое нет ресурсов

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
  console.log(`  прогонов: ${meta.totalRuns} (${meta.bots.join(', ')})`);
  const gameHours = (meta.gameSecondsSimulated / 3600).toFixed(1);
  console.log(`  игровых тиков: ${meta.totalTicks.toLocaleString('ru')} за ${(meta.wallMs / 1000).toFixed(1)}с ` +
    color.dim(`(${gameHours} ч игрового времени, ×${Math.round(meta.ticksPerSecond / meta.tickRate).toLocaleString('ru')} к реальному)`));
  if (meta.errors.length) console.log(color.warn(`  ошибок в консоли: ${meta.errors.length}`));
  console.log(color.dim(`  сырые данные: ${meta.jsonl}`));
}
