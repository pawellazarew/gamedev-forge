import path from 'node:path';
import { boot, loadAdapter } from './harness.mjs';
import { frameStats } from './png.mjs';
import { runDir, linkLatest, writeJson, mean, median, percentile, filterNoise, color, verdictMark } from './util.mjs';

/**
 * Объективные измерения без участия человека: fps, долгие кадры, ошибки,
 * вес, память, draw calls и признаки «мёртвого» кадра.
 * Работает с любой веб-игрой — адаптер не обязателен.
 */
export async function probe(cfg, opts = {}) {
  const { seconds = 8, viewport = cfg.viewport, seed = 1, stamp, headless = true } = opts;
  // Ошибку загрузки адаптера не глушим: сломанный адаптер должен падать,
  // а не притворяться отсутствующим.
  const adapter = cfg.adapterFile ? await loadAdapter(cfg) : null;
  // headless:false запускает настоящий браузер с GPU — единственный способ
  // получить осмысленную стоимость кадра для WebGL-игры.
  const ctx = await boot(cfg, { viewport, seed, adapter, headless });
  const dir = runDir(cfg.dir, 'probe', stamp);

  try {
    // Дать игре добраться до реального геймплея — на титульном экране fps всегда красивый.
    if (adapter?.autostart !== false) {
      await ctx.page.evaluate(() => window.__FORGE__?.start?.({ mode: 0 })).catch(() => {});
    }
    await ctx.page.evaluate(() => window.__forgeResetFrames?.());
    await ctx.page.waitForTimeout(seconds * 1000);

    const raw = await ctx.page.evaluate(() => {
      const f = window.__forgeFrames || { count: 0, long: 0, times: [], work: [], workTotal: 0, workMax: 0 };
      const mem = performance.memory ? performance.memory.usedJSHeapSize : null;
      return {
        frames: f.count, longFrames: f.long, times: f.times.slice(0, 4000),
        work: f.work.slice(0, 4000), workTotal: f.workTotal, workMax: f.workMax,
        elapsedMs: performance.now() - (f.startedAt || performance.now()),
        draws: window.__forgeDraws || 0, heapBytes: mem,
        dpr: window.devicePixelRatio,
        state: window.__FORGE__?.state?.() ?? null,
      };
    });

    // Кадр анализируем по скриншоту, а не изнутри страницы: у WebGL-канваса
    // буфер к этому моменту уже очищен, и любой внутренний замер даст чёрное.
    const framePath = path.join(dir, 'frame.png');
    const shot = await ctx.page.screenshot({ path: framePath });
    let canvasStats = null;
    try {
      canvasStats = frameStats(shot);
    } catch (err) {
      canvasStats = { error: String(err.message || err) };
    }

    // ГЛАВНАЯ метрика — сколько игра реально считала и рисовала внутри кадра.
    // Интервал между кадрами для этого не годится: при живом vsync он равен
    // периоду дисплея (8.3 мс на 120 Гц) независимо от того, сколько работы
    // сделала игра, и «стоимость кадра» из него — фикция.
    const works = raw.work.filter((t) => t >= 0 && t < 5000);
    const frameWorkMs = works.length ? +median(works).toFixed(2) : 0;
    const frameWorkP99Ms = works.length ? +percentile(works, 99).toFixed(2) : 0;
    const frameWorkMaxMs = +(raw.workMax || 0).toFixed(2);
    const headroom = frameWorkMs ? +(16.7 / frameWorkMs).toFixed(2) : 0;
    // Какую долю главного потока игра занимает: 0.5 — половина времени в JS
    const mainThreadBusy = raw.elapsedMs ? +(raw.workTotal / raw.elapsedMs).toFixed(3) : 0;

    // Каденс — справочно: он говорит о частоте показа кадров, а не о цене.
    const dts = raw.times.filter((t) => t > 0 && t < 1000);
    const frameIntervalMs = dts.length ? +median(dts).toFixed(2) : 0;
    const fps = dts.length ? 1000 / mean(dts) : 0;
    const fps1pctLow = dts.length ? 1000 / percentile(dts, 99) : 0;

    const errors = filterNoise(ctx.errors());

    const bundleKb = Math.round(ctx.server.bytes() / 1024);

    const metrics = {
      game: cfg.name,
      viewport,
      seconds,
      loadMs: ctx.loadMs,
      bundleKb,
      frameWorkMs,
      frameWorkP99Ms,
      frameWorkMaxMs,
      mainThreadBusy,
      headroom,
      frameIntervalMs,
      fpsAvg: +fps.toFixed(1),
      fps1pctLow: +fps1pctLow.toFixed(1),
      frames: raw.frames,
      longFrames: raw.longFrames,
      longFrameRatio: raw.frames ? +(raw.longFrames / raw.frames).toFixed(4) : 0,
      drawCallsPerFrame: raw.frames ? Math.round(raw.draws / raw.frames) : 0,
      heapMb: raw.heapBytes ? +(raw.heapBytes / 1048576).toFixed(1) : null,
      canvas: canvasStats,
      // В headless WebGL идёт через софтверный SwiftShader: числа кадра
      // показывают относительную динамику, но не реальную скорость на GPU.
      softwareGl: cfg.renderer === 'webgl' && opts.headless !== false,
      headless: opts.headless !== false,
      errors,
      errorCount: errors.length,
      state: raw.state,
    };

    metrics.checks = evaluateBudgets(metrics, cfg.budgets);
    metrics.verdict = metrics.checks.some((c) => c.status === 'fail') ? 'fail'
      : metrics.checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';

    writeJson(path.join(dir, 'probe.json'), metrics);
    linkLatest(cfg.dir, 'probe', dir);
    return { metrics, dir };
  } finally {
    await ctx.dispose();
  }
}

function evaluateBudgets(m, b) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const budgetMs = b.frameMs ?? 16.7;
  // Софтверный WebGL медленнее GPU в разы, поэтому провал по бюджету здесь
  // не приговор игре — понижаем до предупреждения и говорим почему.
  const costStatus = m.frameWorkMs <= budgetMs ? 'pass' : m.frameWorkMs <= budgetMs * 1.5 ? 'warn' : 'fail';
  add('frame-work', m.softwareGl && costStatus === 'fail' ? 'warn' : costStatus,
    `${m.frameWorkMs} мс работы в кадре (бюджет ≤${budgetMs} мс) — запас ×${m.headroom}, ` +
    `главный поток занят на ${Math.round(m.mainThreadBusy * 100)}%` +
    (m.softwareGl ? ' · софтверный WebGL, сравнивать только с прошлыми прогонами' : ''));

  add('frame-spikes', m.frameWorkP99Ms <= budgetMs * 3 ? 'pass' : m.frameWorkP99Ms <= budgetMs * 6 ? 'warn' : 'fail',
    `p99 работы ${m.frameWorkP99Ms} мс, максимум ${m.frameWorkMaxMs} мс, кадров дольше 50 мс: ${m.longFrames}/${m.frames}`);

  add('errors', m.errorCount <= b.errors ? 'pass' : m.errorCount <= b.errors + 3 ? 'warn' : 'fail',
    m.errorCount ? m.errors.slice(0, 3).map((e) => `${e.kind}: ${e.text}`).join(' | ') : 'чисто');

  add('bundle', m.bundleKb <= b.bundleKb ? 'pass' : m.bundleKb <= b.bundleKb * 1.5 ? 'warn' : 'fail',
    `${m.bundleKb} КБ загружено (бюджет ≤${b.bundleKb} КБ)`);

  add('load', m.loadMs <= b.loadMs ? 'pass' : m.loadMs <= b.loadMs * 2 ? 'warn' : 'fail',
    `${m.loadMs} мс до load (бюджет ≤${b.loadMs} мс)`);

  // Единственный доступный нам прокси GPU-нагрузки: frameWorkMs меряет главный
  // поток и о цене отрисовки не знает ничего. Бюджет задаётся только там, где
  // он осмыслен, — у 3D-игр.
  if (b.drawCalls != null) {
    add('draw-calls', m.drawCallsPerFrame <= b.drawCalls ? 'pass'
      : m.drawCallsPerFrame <= b.drawCalls * 1.5 ? 'warn' : 'fail',
      `${m.drawCallsPerFrame} draw call/кадр (бюджет ≤${b.drawCalls}) — прокси нагрузки на GPU`);
  }

  if (m.canvas && !m.canvas.error) {
    const dead = m.canvas.distinctColors <= 2 || m.canvas.maxLum - m.canvas.minLum < 6;
    add('frame-alive', dead ? 'fail' : 'pass',
      `${m.canvas.distinctColors} различимых цветов, яркость ${m.canvas.minLum}–${m.canvas.maxLum}`);
  }
  return checks;
}

export function printProbe(m) {
  console.log(color.b(`\n${m.game} — probe (${m.viewport}, ${m.seconds}с)`));
  for (const c of m.checks) console.log(`  ${verdictMark(c.status)} ${c.name.padEnd(13)} ${c.detail}`);
  console.log(color.dim(`  draw calls/кадр: ${m.drawCallsPerFrame}${m.heapMb ? `, heap ${m.heapMb} МБ` : ''}` +
    `  ·  каденс ${m.frameIntervalMs} мс (${m.fpsAvg} кадр/с) — частота показа, не цена кадра`));
}
