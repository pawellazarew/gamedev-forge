import path from 'node:path';
import { boot, loadAdapter, loadScenarios } from './harness.mjs';
import { applyStep } from './scenario.mjs';
import { frameStats } from './png.mjs';
import { runDir, linkLatest, writeJson, mean, median, percentile, filterNoise, color, verdictMark } from './util.mjs';

/**
 * Объективные измерения без участия человека: работа главного потока в кадре,
 * пик draw call'ов, ошибки, вес, память и признаки «мёртвого» кадра.
 * Работает с любой веб-игрой — адаптер не обязателен.
 */
export async function probe(cfg, opts = {}) {
  const { seconds = 8, viewport = cfg.viewport, seed = 1, stamp, headless = true, scenario = null } = opts;
  // Ошибку загрузки адаптера не глушим: сломанный адаптер должен падать,
  // а не притворяться отсутствующим.
  const adapter = cfg.adapterFile ? await loadAdapter(cfg) : null;
  // headless:false запускает настоящий браузер с GPU — единственный способ
  // получить осмысленную стоимость кадра для WebGL-игры.
  const ctx = await boot(cfg, { viewport, seed, adapter, headless });
  const dir = runDir(cfg.dir, 'probe', stamp);

  try {
    let scenePath = null;
    if (scenario) {
      // Мерить надо тяжёлую сцену, а не стартовую комнату: `--scenario storm-peak`
      // прогоняет шаги обычного сценария (без съёмки) и только потом включает
      // счётчики. Без этого требование «замерить пик» не автоматизируется.
      const all = await loadScenarios(cfg);
      const sc = all.find((s) => s.name === scenario);
      if (!sc) {
        throw new Error(`Сценарий "${scenario}" не найден. Есть: ${all.map((s) => s.name).join(', ') || '(ни одного)'}`);
      }
      for (const [i, step] of (sc.steps || []).entries()) {
        await applyStep(ctx.page, step, { sc, i, shots: [], checks: [], cfg, skipShots: true });
      }
      scenePath = sc.name;
    } else if (adapter?.autostart !== false) {
      // Хоть до геймплея: на титульном экране кадр всегда дешёвый.
      await ctx.page.evaluate(() => window.__FORGE__?.start?.({ mode: 0 })).catch(() => {});
    }

    await ctx.page.evaluate(() => window.__forgeResetFrames?.());
    await ctx.page.waitForTimeout(seconds * 1000);

    const raw = await ctx.page.evaluate(() => {
      const f = window.__forgeFrames || {};
      const mem = performance.memory ? performance.memory.usedJSHeapSize : null;
      return {
        frames: f.count || 0, longFrames: f.long || 0, times: (f.times || []).slice(0, 4000),
        work: (f.work || []).slice(0, 4000), workTotal: f.workTotal || 0, workMax: f.workMax || 0,
        draws: (f.draws || []).slice(0, 4000), drawsMax: f.drawsMax || 0, drawsTotal: window.__forgeDraws || 0,
        elapsedMs: performance.now() - (f.startedAt || performance.now()),
        heapBytes: mem,
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

    const metrics = computeMetrics(raw, {
      cfg, viewport, seconds, scenario: scenePath, headless,
      loadMs: ctx.loadMs,
      bundleKb: Math.round(ctx.server.bytes() / 1024),
      errors: filterNoise(ctx.errors()),
      canvas: canvasStats,
    });

    writeJson(path.join(dir, 'probe.json'), metrics);
    linkLatest(cfg.dir, 'probe', dir);
    return { metrics, dir };
  } finally {
    await ctx.dispose();
  }
}

/**
 * Чистая функция: сырые счётчики из страницы → метрики и вердикт.
 * Отделена от браузера, чтобы её можно было проверить тестами без запуска игры.
 */
export function computeMetrics(raw, {
  cfg, viewport, seconds, scenario = null, headless = true,
  loadMs = 0, bundleKb = 0, errors = [], canvas = null,
}) {
  const budgetMs = cfg.budgets?.frameMs ?? 16.7;

  // ГЛАВНАЯ метрика — сколько игра реально считала и рисовала внутри кадра.
  // Интервал между кадрами для этого не годится: при живом vsync он равен
  // периоду дисплея (8.3 мс на 120 Гц) независимо от объёма работы.
  const works = (raw.work || []).filter((t) => t >= 0 && t < 5000);
  const frameWorkMs = works.length ? +median(works).toFixed(2) : 0;
  const frameWorkP99Ms = works.length ? +percentile(works, 99).toFixed(2) : 0;
  const frameWorkMaxMs = +(raw.workMax || 0).toFixed(2);
  // Запас считаем от НАСТРОЕННОГО бюджета: у 3D-прототипов он 8 мс, и запас
  // «×1.67» относительно 16.7 был бы утешительной выдумкой.
  const headroom = frameWorkMs ? +(budgetMs / frameWorkMs).toFixed(2) : 0;
  const mainThreadBusy = raw.elapsedMs ? +(raw.workTotal / raw.elapsedMs).toFixed(3) : 0;

  // Каденс — справочно: частота показа кадров, а не их цена.
  const dts = (raw.times || []).filter((t) => t > 0 && t < 1000);
  const frameIntervalMs = dts.length ? +median(dts).toFixed(2) : 0;
  const fps = dts.length ? 1000 / mean(dts) : 0;
  const fps1pctLow = dts.length ? 1000 / percentile(dts, 99) : 0;

  // Draw calls — покадрово. Гейт по пику, а не по среднему: тормозит игра
  // на тяжёлом кадре, и он же вылетает из бюджета GPU.
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
    longFrames: raw.longFrames,
    longFrameRatio: raw.frames ? +(raw.longFrames / raw.frames).toFixed(4) : 0,
    drawCallsMedian,
    drawCallsP99,
    drawCallsMax,
    drawCallsAvg,
    heapMb: raw.heapBytes ? +(raw.heapBytes / 1048576).toFixed(1) : null,
    canvas,
    // В headless WebGL идёт через софтверный SwiftShader: числа кадра
    // показывают относительную динамику, но не реальную скорость на GPU.
    softwareGl: cfg.renderer === 'webgl' && headless,
    headless,
    errors,
    errorCount: errors.length,
    state: raw.state ?? null,
  };

  metrics.checks = evaluateBudgets(metrics, cfg.budgets || {});
  metrics.verdict = metrics.checks.some((c) => c.status === 'fail') ? 'fail'
    : metrics.checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return metrics;
}

export function evaluateBudgets(m, b) {
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

  add('errors', m.errorCount <= (b.errors ?? 0) ? 'pass' : m.errorCount <= (b.errors ?? 0) + 3 ? 'warn' : 'fail',
    m.errorCount ? m.errors.slice(0, 3).map((e) => `${e.kind}: ${e.text}`).join(' | ') : 'чисто');

  if (b.bundleKb != null) {
    add('bundle', m.bundleKb <= b.bundleKb ? 'pass' : m.bundleKb <= b.bundleKb * 1.5 ? 'warn' : 'fail',
      `${m.bundleKb} КБ загружено (бюджет ≤${b.bundleKb} КБ)`);
  }

  if (b.loadMs != null) {
    add('load', m.loadMs <= b.loadMs ? 'pass' : m.loadMs <= b.loadMs * 2 ? 'warn' : 'fail',
      `${m.loadMs} мс до load (бюджет ≤${b.loadMs} мс)`);
  }

  // Единственный доступный прокси GPU-нагрузки: frameWorkMs меряет главный
  // поток и о цене отрисовки не знает.
  //
  // Гейт по МАКСИМУМУ, а не по среднему и не по p99. Среднее прячет пик
  // очевидным образом (один кадр с 600 вызовами при среднем 7). Но и p99
  // ненадёжен: единственный тяжёлый кадр среди ста — это ровно 1% выборки,
  // и перцентиль его теряет, хотя игрок этот фриз увидит. Для draw call'ов
  // выброс — не шум измерения, а настоящая работа GPU.
  if (b.drawCalls != null) {
    const peak = m.drawCallsMax;
    add('draw-calls', peak <= b.drawCalls ? 'pass' : peak <= b.drawCalls * 1.5 ? 'warn' : 'fail',
      `пик ${peak} draw call/кадр (бюджет ≤${b.drawCalls}), p99 ${m.drawCallsP99}, медиана ${m.drawCallsMedian}` +
      ' — прокси нагрузки на GPU');
  }

  if (m.canvas && !m.canvas.error) {
    const dead = m.canvas.distinctColors <= 2 || m.canvas.maxLum - m.canvas.minLum < 6;
    add('frame-alive', dead ? 'fail' : 'pass',
      `${m.canvas.distinctColors} различимых цветов, яркость ${m.canvas.minLum}–${m.canvas.maxLum}`);
  }
  return checks;
}

export function printProbe(m) {
  const scene = m.scenario ? `, сцена «${m.scenario}»` : '';
  console.log(color.b(`\n${m.game} — probe (${m.viewport}, ${m.seconds}с${scene})`));
  for (const c of m.checks) console.log(`  ${verdictMark(c.status)} ${c.name.padEnd(13)} ${c.detail}`);
  console.log(color.dim(`  draw calls: медиана ${m.drawCallsMedian}, p99 ${m.drawCallsP99}, макс ${m.drawCallsMax}` +
    `${m.heapMb ? ` · heap ${m.heapMb} МБ` : ''}` +
    `  ·  каденс ${m.frameIntervalMs} мс (${m.fpsAvg} кадр/с) — частота показа, не цена кадра`));
}
