import path from 'node:path';
import { boot, loadAdapter, loadScenarios } from './harness.mjs';
import { applyStep } from './scenario.mjs';
import { resolveViewport } from './browser.mjs';
import { frameStats, pixelDiffRatio } from './png.mjs';
import { runDir, linkLatest, writeJson, mean, median, percentile, filterNoise, color, verdictMark } from './util.mjs';

/** Меньше этого числа кадров — мерить нечего, вердикт по производительности пуст. */
export const MIN_FRAMES = 5;
/** Кадров хватает на число, но не на доверие к нему. */
export const THIN_FRAMES = 20;
/** Ниже этой доли перерисованных кадров игра рисует урывками, а не живёт. */
export const MIN_PAINT_SHARE = 0.5;
/**
 * Доля изменившихся пикселей, ниже которой картинка считается застывшей.
 * Замерено: у застывших фикстур (zombie, ghost-backbuffer, dirty-render) и у
 * WebGL-игры, перерисовывающей одинаковые кадры, ровно 0; у живых — от 0.0006
 * (Phaser 3 на спокойной сцене) до 0.026. Порог поставлен в пустоту между
 * ними и намеренно ближе к нулю: ошибиться в сторону «шевелится» безопаснее,
 * чем обвинить живую игру.
 */
export const PIXEL_CHANGE_EPS = 0.0001;
/** Сколько ждём start(): зависший старт должен давать красный прогон, а не висеть в CI. */
const START_TIMEOUT_MS = 30000;

/** Промис с крайним сроком: у page.evaluate своего таймаута нет. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

/**
 * Объективные измерения без участия человека: работа главного потока в кадре,
 * пик draw call'ов, ошибки, вес, память и признаки «мёртвого» кадра.
 * Работает с любой веб-игрой — адаптер не обязателен.
 */
export async function probe(cfg, opts = {}) {
  const { seconds = 8, seed = 1, stamp, headless = true, scenario = null } = opts;
  // Замер нулевой длины давал 0 кадров, 0 мс работы и зелёный вердикт — то есть
  // performance gate, который проходит любая игра. Проверяем до всего остального,
  // чтобы опечатка стоила ошибку, а не запуск браузера.
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--seconds должен быть положительным числом, получено «${seconds}»: замер нулевой длины ничего не измеряет`);
  }
  // Ошибку загрузки адаптера не глушим: сломанный адаптер должен падать,
  // а не притворяться отсутствующим.
  const adapter = cfg.adapterFile ? await loadAdapter(cfg) : null;

  // Сценарий ищем ДО запуска браузера: вьюпорт задаётся при создании контекста
  // и потом не меняется, а сцена «phone», снятая в десктопном окне, — это
  // замер другой сцены.
  const sc = scenario ? await findScenario(cfg, scenario) : null;
  const viewport = resolveViewport(opts.viewport, sc, cfg);

  // headless:false запускает настоящий браузер с GPU — единственный способ
  // получить осмысленную стоимость кадра для WebGL-игры.
  const ctx = await boot(cfg, { viewport, seed, adapter, headless });

  try {
    let scenePath = null;
    if (sc) {
      // Мерить надо тяжёлую сцену, а не стартовую комнату: `--scenario storm-peak`
      // прогоняет шаги обычного сценария (без съёмки) и только потом включает
      // счётчики. Без этого требование «замерить пик» не автоматизируется.
      await prepareScene(ctx.page, sc, cfg);
      scenePath = sc.name;
    } else if (adapter?.autostart !== false) {
      // Хоть до геймплея: на титульном экране кадр всегда дешёвый.
      //
      // Ошибку start() НЕ глушим. По контракту адаптера start() обязателен, и
      // упавший старт означает ровно одно: probe померит титульный экран и
      // назовёт его игрой. Возвращаемое значение при этом намеренно
      // выбрасываем — start(), вернувший что-нибудь несериализуемое, ронял бы
      // evaluate на ровном месте.
      try {
        // `async` и `await` тут несущие: без них промис асинхронного start()
        // выбрасывается, evaluate возвращается сразу, а замер идёт по
        // стартовому экрану — и падение start() снова оказывается проглочено.
        // Значение всё равно не возвращаем: несериализуемый результат ронял бы
        // evaluate на ровном месте.
        const started = await withTimeout(
          ctx.page.evaluate(async () => {
            const api = window.__FORGE__;
            if (!api) return 'нет __FORGE__';
            if (typeof api.start !== 'function') return 'нет start()';
            await api.start({ mode: 0 });
            return null;
          }),
          START_TIMEOUT_MS,
          `start() не завершился за ${START_TIMEOUT_MS / 1000} с`,
        );
        // Адаптер подключён — значит start() обязателен по контракту. Молча
        // мерить стартовый экран из-за опечатки в имени метода нельзя.
        if (adapter && started) throw new Error(`${started} — адаптер обязан ставить window.__FORGE__.start()`);
      } catch (err) {
        throw new Error(`__FORGE__.start() упал: ${String(err?.message || err).slice(0, 300)}. `
          + 'Замер отменён: probe померил бы стартовый экран вместо игры.');
      }
    }

    // Каталог заводим после подготовки сцены: у сорванного замера свой,
    // с красным вердиктом и причиной.
    const dir = runDir(cfg.dir, 'probe', stamp);

    // Кадр «до» — страховка на случай, если игра рисует мимо инструментированных
    // API (воркер, WebGPU, DOM/CSS): тогда команд рисования не видно, а пиксели
    // всё равно меняются, и красный вердикт был бы враньём. Снимаем ДО сброса
    // счётчиков, чтобы полсотни миллисекунд самого скриншота не попали в окно.
    //
    // Снимаем КАНВАС, а не страницу: счётчик кадров в DOM рядом с игрой — это
    // «пиксели меняются» при намертво застывшей игре.
    // Считать отрисовку и сравнивать пиксели надо по ОДНОМУ И ТОМУ ЖЕ канвасу.
    // Разрешаем его один раз здесь и отдаём странице САМ ЭЛЕМЕНТ: два
    // независимых `querySelector` расходятся на любой странице с двумя
    // канвасами, а Playwright вдобавок пробивает shadow DOM, чего
    // `document.querySelector` внутри страницы не делает.
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

    // Доля изменившихся пикселей, а не «побайтово равны»: моргающий счётчик
    // не должен выдавать застывшую игру за живую.
    let pixelChange = null;
    try {
      const after = await shoot(canvasEl, ctx.page);
      pixelChange = +pixelDiffRatio(before, after).toFixed(4);
      // «Живой ли кадр» тоже про игровой канвас, а не про страницу: игра с
      // чёрным канвасом проходила на цветах окружающей вёрстки.
      canvasStats = frameStats(after);
    } catch { /* не сравнили — значит «не знаем», а не «застыло» */ }

    const metrics = computeMetrics(raw, {
      cfg, viewport, seconds, scenario: scenePath, headless,
      loadMs: ctx.loadMs,
      bundleKb: Math.round(ctx.server.bytes() / 1024),
      errors: filterNoise(ctx.errors()),
      canvas: canvasStats,
      pixelChange,
    });

    writeJson(path.join(dir, 'probe.json'), metrics);
    linkLatest(cfg.dir, 'probe', dir);
    return { metrics, dir };
  } catch (err) {
    // Любой срыв — сцена, старт, упавший скриншот, схлопнувшийся браузер —
    // обязан оставить красный артефакт. Иначе после него latest-probe
    // указывает на прошлый зелёный прогон, и `report`/`critique` выдают
    // вчерашние числа за сегодняшние.
    writeAbort(cfg, { stamp, ctx, viewport, seconds, scenario: sc?.name ?? null, headless, reason: String(err?.message || err) });
    throw err;
  } finally {
    await ctx.dispose();
  }
}

/** Пустые счётчики: замер не состоялся, и метрики должны говорить именно это. */
// paintFrames: null — «не мерили». Ноль означал бы «игра не рисовала», и
// артефакт сорванного замера утверждал бы про рендер то, чего никто не видел.
const NO_MEASUREMENT = {
  frames: 0, longFrames: 0, times: [], work: [], workTotal: 0, workMax: 0,
  gameFrames: 0, paintFrames: null, otherPaintFrames: null, draws: [], drawsMax: 0, drawsTotal: 0,
  elapsedMs: 0, heapBytes: null, state: null,
};

/**
 * Артефакт сорванного замера: полноценный probe.json с красным вердиктом.
 * Сама по себе упасть не имеет права — иначе подменит собой исходную ошибку,
 * ради которой её и вызвали.
 */
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

/**
 * Игровой канвас: явный селектор, иначе самый большой видимый.
 * Первый в DOM не годится — полоска индикатора или прелоадер, объявленные
 * раньше игрового канваса, забирали бы на себя весь замер отрисовки.
 */
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

/**
 * Снимок канваса; если его нет или он спрятан — страницы целиком.
 * Без таймаута скриншот спрятанного канваса ждёт видимости полминуты и
 * роняет прогон по чужой причине.
 */
async function shoot(el, page) {
  if (el) {
    try {
      return await el.screenshot({ timeout: 2000 });
    } catch { /* спрятан, пересоздан или отвалился — снимем страницу */ }
  }
  return page.screenshot();
}

async function findScenario(cfg, name) {
  const all = await loadScenarios(cfg);
  const sc = all.find((s) => s.name === name);
  if (!sc) {
    throw new Error(`Сценарий "${name}" не найден. Есть: ${all.map((s) => s.name).join(', ') || '(ни одного)'}`);
  }
  return sc;
}

/**
 * Довести игру до нужной сцены теми же шагами, что и сценарий.
 *
 * Проваленный expect здесь — не замечание, а отмена замера. Раньше каждому шагу
 * доставался свой пустой массив checks, он тут же терялся, и probe продолжал
 * мерить сцену, которая не собралась: числа выходили зелёными именно потому,
 * что измеряли не то.
 */
export async function prepareScene(page, sc, cfg) {
  const checks = [];
  for (const [i, step] of (sc.steps || []).entries()) {
    await applyStep(page, step, { sc, i, shots: [], checks, cfg, skipShots: true });
    const failed = checks.find((c) => c.status === 'fail');
    if (failed) {
      throw new Error(
        `Сцена «${sc.name}» не подготовлена: шаг ${i + 1}, «${failed.name}» — ${failed.detail}. ` +
        'Замер отменён: мерить неподготовленную сцену бессмысленно.',
      );
    }
  }
  return checks;
}

/**
 * Чистая функция: сырые счётчики из страницы → метрики и вердикт.
 * Отделена от браузера, чтобы её можно было проверить тестами без запуска игры.
 */
export function computeMetrics(raw, {
  cfg, viewport, seconds, scenario = null, headless = true,
  loadMs = 0, bundleKb = 0, errors = [], canvas = null, pixelChange = null,
}) {
  const budgetMs = cfg.budgets?.frameMs ?? 16.7;

  // ГЛАВНАЯ метрика — сколько игра реально считала и рисовала внутри кадра.
  // Интервал между кадрами для этого не годится: при живом vsync он равен
  // периоду дисплея (8.3 мс на 120 Гц) независимо от объёма работы.
  const works = (raw.work || []).filter((t) => t >= 0 && t < 5000);
  // Размер выборки — часть результата, а не служебная деталь: без него ноль
  // миллисекунд «уложился в бюджет» неотличим от «замера не было».
  const workSamples = works.length;
  const frameWorkMs = works.length ? +median(works).toFixed(2) : 0;
  const frameWorkP99Ms = works.length ? +percentile(works, 99).toFixed(2) : 0;
  const frameWorkMaxMs = +(raw.workMax || 0).toFixed(2);
  // Запас считаем от НАСТРОЕННОГО бюджета: у 3D-прототипов он 8 мс, и запас
  // «×1.67» относительно 16.7 был бы утешительной выдумкой.
  const headroom = frameWorkMs ? +(budgetMs / frameWorkMs).toFixed(2) : 0;
  const mainThreadBusy = raw.elapsedMs ? +(raw.workTotal / raw.elapsedMs).toFixed(3) : 0;

  // Каденс — справочно: частота показа кадров, а не их цена.
  const dts = (raw.times || []).filter((t) => t > 0 && t < 1000);
  const frameSamples = dts.length;
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
    // Кадры пробы и кадры игры расходятся ровно там, где это важно: мёртвый
    // цикл рендера даёт полсотни кадров пробы и ноль кадров игры.
    gameFrames: raw.gameFrames ?? null,
    // Кадры с фактической отрисовкой: живой цикл rAF ещё не значит, что игра
    // что-то нарисовала.
    paintFrames: raw.paintFrames ?? null,
    // На каком кадре пробы игра рисовала в последний раз: «рисует редко» и
    // «рисовал и умер» дают одинаковую долю кадров и различаются только этим.
    lastPaintAt: raw.lastPaintAt ?? null,
    // Кадры, в которых игра рисовала на ДРУГОМ канвасе: это не приговор, а
    // подсказка «probe смотрит не на тот канвас».
    otherPaintFrames: raw.otherPaintFrames ?? null,
    // Доля изменившихся пикселей канваса между началом и концом окна;
    // null — сравнить не удалось, и это «не знаем», а не «застыло».
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

/**
 * Причина у провала выборки всегда одна из трёх, и лечатся они по-разному.
 * Общая формулировка «слишком короткий --seconds» на мёртвом цикле рендера
 * отправляет чинить не то.
 */
function sampleFailure(frames, gameFrames, workSamples, seconds) {
  if (frames < MIN_FRAMES) {
    return `кадров пробы ${frames} за ${seconds ?? '?'} с — окно замера почти нулевое `
      + 'или вкладка заморожена: подними --seconds';
  }
  if (gameFrames === 0) {
    return `игра не нарисовала ни одного кадра за ${frames} кадров пробы — цикл рендера не запущен, `
      + 'сломан или идёт не через requestAnimationFrame (тогда probe этой игре не судья)';
  }
  if (workSamples === 0) {
    return `${gameFrames} кадров игры, но ни одного валидного замера работы — `
      + 'инструментирование кадра сломано, числам верить нельзя';
  }
  return `кадров игры ${gameFrames} из ${frames} кадров пробы — нужно ≥${MIN_FRAMES}: `
    + 'игра рисует урывками или окно замера слишком короткое';
}

export function evaluateBudgets(m, b) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // Первой идёт достоверность самого замера. Пустая выборка красит всё
  // остальное в зелёный: ноль миллисекунд работы укладывается в любой бюджет,
  // ноль draw call'ов — тоже. Это провал ЗАМЕРА, а не игры, и молчать о нём
  // нельзя: иначе `--seconds 0` (или мёртвый цикл рендера) выдаёт зелёный
  // performance gate, который не проходил никто.
  //
  // Считаем кадры ИГРЫ. Кадры пробы для этого не годятся: tickProbe крутит
  // свой rAF сам и насчитает полсотни «кадров» странице, которая ничего не
  // рисует, — то есть ровно тот случай, ради которого проверка и добавлена.
  const frames = m.frames || 0;
  const gameFrames = m.gameFrames ?? frames;   // старые probe.json без поля читаем по-старому
  const workSamples = m.workSamples ?? 0;
  const onDemand = m.renderMode === 'on-demand';
  const partial = workSamples > 0 && workSamples < gameFrames;
  const measured = gameFrames >= MIN_FRAMES && workSamples > 0;
  // Игра, рисующая по событию, может честно не нарисовать НИ ОДНОГО кадра и
  // не завести rAF вовсе — настоящий Wordle так и устроен. Стоимость кадра у
  // неё не измерена, и это единственное, что тут можно сказать честно.
  // Красный вердикт означал бы «сломана», а она работает.
  const emptyWindow = frames < MIN_FRAMES;
  // Помилование ровно на один случай: цикла нет вовсе. Один-четыре кадра игры
  // означают, что цикл был и оборвался, — а это поломка при любом renderMode.
  const pardon = onDemand && !emptyWindow && gameFrames === 0;
  add('sample',
    measured ? ((gameFrames < THIN_FRAMES || partial) ? 'warn' : 'pass')
      : pardon ? 'warn' : 'fail',
    measured
      ? `${gameFrames} кадров игры из ${frames} кадров пробы за ${m.seconds ?? '?'} с`
        + (gameFrames < THIN_FRAMES ? ` — выборка тоньше ${THIN_FRAMES} кадров, числа шумят` : '')
        + (partial ? ` — замеров работы только ${workSamples}: числа описывают начало окна, а не всё` : '')
      : pardon
        ? `цикл рендера не запускался за ${m.seconds ?? '?'} с — стоимость кадра не измерена. `
          + 'renderMode: on-demand, игра рисует по событию: без ввода ей нечего перерисовывать'
        : sampleFailure(frames, gameFrames, workSamples, m.seconds));

  // Живой цикл rAF — ещё не отрисовка. `requestAnimationFrame(loop)` с пустым
  // телом даёт полный набор кадров игры на застывшей картинке, и по кадрам
  // всё выглядит идеально. Считаем кадры, в которых игра выдавала команды
  // рисования (2D-канвас или WebGL).
  //
  // Одних команд мало для приговора: игра может рисовать мимо них — из воркера,
  // через WebGPU или вообще средствами DOM/CSS. Поэтому решает пара «команд не
  // видно» + «ни один пиксель не изменился»; если пиксели меняются, это
  // предупреждение о слепой зоне инструментирования, а не провал игры.
  const paintFrames = m.paintFrames ?? null;
  // При нуле кадров игры говорить о её отрисовке нечего — там уже высказался
  // sample, а «цикл крутится» было бы прямой ложью.
  if (paintFrames != null && gameFrames > 0) {
    const share = paintFrames / gameFrames;
    // Доля, а не абсолютное число: пять перерисованных кадров из семисот —
    // это умерший на второй секунде рендер, а не живая игра.
    const enoughPaint = paintFrames >= MIN_FRAMES && share >= MIN_PAINT_SHARE;
    const frozen = m.pixelChange != null && m.pixelChange < PIXEL_CHANGE_EPS;
    const pct = `${Math.round(share * 100)}%`;

    // «Рисует редко» и «рисовал и перестал» дают одинаковую долю кадров.
    // Различает их только хвост окна: игра, которая перерисовалась пять раз
    // в начале и умерла, — авария, а не редкая перерисовка.
    const tail = Math.max(MIN_FRAMES, Math.round(frames * 0.25));
    const gap = paintFrames > 0 && m.lastPaintAt != null ? frames - m.lastPaintAt : null;
    const stopped = gap != null && gap > tail;

    // «Рисует каждый кадр, а картинка не меняется» — это потерянный blit,
    // рендер в никуда или застрявшая сцена. Не провал (WebGL-игра честно
    // перерисовывает одинаковые кадры), но и не молчание.
    // Провал за остановку — только если игра до этого рисовала ПОЛНОЦЕННО.
    // Иначе под него попадает заставка, которая доиграла анимацию и замерла в
    // ожидании ввода, — а таких экранов у любой игры больше, чем сломанных
    // рендеров. Порог доли при этом абсолютный, а хвост — доля окна, поэтому
    // без этого условия вердикт зависел бы ещё и от каденса раннера.
    //
    // Застывшие пиксели при полноценной отрисовке — НЕ повод для жёлтого.
    // Игра, дошедшая до «game over», вставшая на паузу или показывающая
    // спокойную сцену, честно перерисовывает одну и ту же картинку, и отличить
    // её от рисунка в никуда без ввода нечем. Замерено: у здоровой фикстуры
    // tiny-game это ровно тот случай на односекундном окне. Пишем пометкой в
    // тексте — потерянный blit ловится тем, что отрисовки на игровом канвасе
    // нет вовсе.
    const status = paintFrames === 0 ? (!frozen ? 'warn' : onDemand ? 'warn' : 'fail')
      : (stopped && enoughPaint) ? (onDemand ? 'warn' : 'fail')
        : (stopped || !enoughPaint) ? 'warn'
          : 'pass';

    add('render', status,
      paintFrames === 0
        ? (!frozen
          ? `команд рисования не видно за ${gameFrames} кадров игры, но пиксели канваса меняются — `
            + 'игра рисует мимо 2D/WebGL (воркер, WebGPU, DOM/CSS): цена кадра измерена, живость рендера — нет'
          : `за ${m.seconds ?? '?'} с игра не выдала ни одной команды рисования и ни один пиксель канваса `
            + `не изменился (${gameFrames} кадров игры вхолостую) — рендер мёртв`
            + (m.otherPaintFrames ? `. Но на другом канвасе отрисовка шла ${m.otherPaintFrames} кадров — `
              + 'если игровой канвас не тот, укажи canvasSelector в конфиге' : '')
            + (onDemand ? '. renderMode: on-demand — для игры, которая рисует по событию, это норма' : ''))
        : stopped
          ? `отрисовка встала: последняя за ${gap} кадров до конца окна `
            + `(всего ${paintFrames} из ${gameFrames} кадров игры, ${pct})`
            + (enoughPaint ? '' : ' — либо рендер умер, либо экран доиграл анимацию и ждёт ввода')
            + (onDemand ? '. renderMode: on-demand — игра рисует по событию' : '')
          : paintFrames < MIN_FRAMES
            ? `кадров с отрисовкой всего ${paintFrames} — судить о рендере не по чему`
            : !enoughPaint
              ? `только ${paintFrames} из ${gameFrames} кадров игры с отрисовкой (${pct}) — игра почти не перерисовывается`
              : `${paintFrames} из ${gameFrames} кадров игры с отрисовкой (${pct})`
              + (frozen ? ' — но пиксели канваса не изменились: игра завершилась, стоит на паузе или рисует одно и то же' : ''));
  }

  // Числа кадра существуют, только если кадры были. Без замера ноль
  // миллисекунд работы и ноль draw call'ов «укладываются» в любой бюджет и
  // рисуют частокол зелёных проверок под красным sample. Молчание честнее.
  // Вес, время загрузки, ошибки и «живой кадр» от кадров не зависят и
  // считаются всегда.
  const budgetMs = b.frameMs ?? 16.7;
  if (measured) {
    // Софтверный WebGL медленнее GPU в разы, поэтому провал по бюджету здесь
    // не приговор игре — понижаем до предупреждения и говорим почему.
    const costStatus = m.frameWorkMs <= budgetMs ? 'pass' : m.frameWorkMs <= budgetMs * 1.5 ? 'warn' : 'fail';
    add('frame-work', m.softwareGl && costStatus === 'fail' ? 'warn' : costStatus,
      `${m.frameWorkMs} мс работы в кадре (бюджет ≤${budgetMs} мс) — запас ×${m.headroom}, ` +
      // Именно «внутри rAF», а не «главный поток»: работа в setTimeout, в
      // обработчиках событий и в парсинге сюда не попадает. Обещать больше,
      // чем мерим, — врать в ту самую сторону, где всё зелено.
      `внутри rAF занято ${Math.round(m.mainThreadBusy * 100)}% времени` +
      (m.softwareGl ? ' · софтверный WebGL, сравнивать только с прошлыми прогонами' : ''));

    const spikeStatus = m.frameWorkP99Ms <= budgetMs * 3 ? 'pass' : m.frameWorkP99Ms <= budgetMs * 6 ? 'warn' : 'fail';
    add('frame-spikes', m.softwareGl && spikeStatus === 'fail' ? 'warn' : spikeStatus,
      `p99 работы ${m.frameWorkP99Ms} мс, максимум ${m.frameWorkMaxMs} мс`);
  }

  // Подвисания считаются по кадрам ПРОБЫ и работы игры не требуют вовсе —
  // значит и молчать вместе с числами кадра не должны. Иначе единственный
  // детектор работы ВНЕ rAF выключался бы ровно для тех игр, которые всю
  // работу там и делают: блокирующий setInterval не попадает ни в frameWorkMs,
  // ни в «занято внутри rAF», но растягивает интервал между кадрами.
  //
  // На каденс (кадр/с) гейт вешать нельзя — в headless он упирается в потолок
  // браузера (30 кадр/с на обеих фикстурах) и мерил бы харнесс, а не игру.
  // Доля длинных кадров от этого потолка не зависит: 33 мс — это не 50 мс.
  if (frames >= MIN_FRAMES) {
    const ratio = m.longFrameRatio ?? 0;
    const stallStatus = ratio <= 0.02 ? 'pass' : ratio <= 0.2 ? 'warn' : 'fail';
    add('stalls', m.softwareGl && stallStatus === 'fail' ? 'warn' : stallStatus,
      `кадров дольше 50 мс: ${m.longFrames}/${frames} (${Math.round(ratio * 100)}%)`
      + (stallStatus !== 'pass' ? ' — игра встаёт: работа вне rAF или тяжёлый кадр' : ''));
  }

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
  if (measured && b.drawCalls != null) {
    const peak = m.drawCallsMax;
    // Ноль вызовов при живом рендере — это не «уложились в бюджет», а
    // «счётчик не сработал»: бюджет, который невозможно провалить, бесполезен.
    const neverFired = peak === 0 && (m.gameFrames ?? m.frames ?? 0) >= MIN_FRAMES;
    add('draw-calls', neverFired ? 'fail' : peak <= b.drawCalls ? 'pass' : peak <= b.drawCalls * 1.5 ? 'warn' : 'fail',
      neverFired
        ? 'счётчик draw call не сработал ни разу при живом рендере — игра рисует не через WebGL '
          + '(2D-канвас, WebGPU или OffscreenCanvas в воркере). Бюджет drawCalls для неё бессмыслен'
        : `пик ${peak} draw call/кадр (бюджет ≤${b.drawCalls}), p99 ${m.drawCallsP99}, медиана ${m.drawCallsMedian}`
          + ' — прокси нагрузки на GPU');
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
  // Справочную строку печатаем только когда за ней стоят настоящие кадры:
  // «медиана 0, каденс 0 мс (0 кадр/с)» — это не данные, а вид данных.
  if (m.checks.some((c) => c.name === 'frame-work')) {
    console.log(color.dim(`  draw calls: медиана ${m.drawCallsMedian}, p99 ${m.drawCallsP99}, макс ${m.drawCallsMax}` +
      `${m.heapMb ? ` · heap ${m.heapMb} МБ` : ''}` +
      `  ·  каденс ${m.frameIntervalMs} мс (${m.fpsAvg} кадр/с) — частота показа, не цена кадра`));
  }
}
