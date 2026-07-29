import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from './server.mjs';
import { launch, newPage, viewport as viewportPreset } from './browser.mjs';

/**
 * Конфиг игры: <gameDir>/forge.config.mjs. Всё опционально кроме root/entry —
 * без адаптера доступен универсальный слой (shots/probe/play), с адаптером — sim.
 */
const DEFAULTS = {
  name: 'game',
  root: '.',
  entry: 'index.html',
  viewport: 'desktop',
  renderer: '2d',        // '2d' | 'webgl' — влияет на флаги запуска браузера
  // 'continuous' — игра перерисовывается каждый кадр (аркады, экшены);
  // 'on-demand'  — рисует только по событию (пошаговые, Wordle-подобные).
  // Во втором случае «за 3 секунды ничего не нарисовано» — норма, а не поломка.
  renderMode: 'continuous',
  // Какой канвас считать игровым, если их на странице несколько. Пусто —
  // берётся самый большой видимый: игровой почти всегда крупнее индикаторов
  // и прелоадеров, а первый в DOM — это как повезёт.
  canvasSelector: null,
  adapter: null,
  scenarios: null,
  references: 'forge/references',
  budgets: { frameMs: 16.7, errors: 0, bundleKb: 8000, loadMs: 3000 },
};

export async function loadConfig(gameDir) {
  const dir = path.resolve(gameDir);
  const file = path.join(dir, 'forge.config.mjs');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Нет forge.config.mjs в ${dir}\n` +
      `Создай его: node tools/game-forge/bin/forge.mjs init ${gameDir}`,
    );
  }
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  const cfg = { ...DEFAULTS, ...mod.default };
  // Опечатка в renderMode тихо возвращала бы игру под гейт «рендер мёртв»,
  // хотя автор от него отписался.
  if (!['continuous', 'on-demand'].includes(cfg.renderMode)) {
    throw new Error(`renderMode: "${cfg.renderMode}" — допустимы только 'continuous' и 'on-demand'`);
  }
  cfg.budgets = { ...DEFAULTS.budgets, ...(mod.default.budgets || {}) };
  cfg.dir = dir;
  cfg.rootDir = path.resolve(dir, cfg.root);
  cfg.referencesDir = path.resolve(dir, cfg.references);
  cfg.adapterFile = cfg.adapter ? path.resolve(dir, cfg.adapter) : null;
  cfg.scenariosFile = cfg.scenarios ? path.resolve(dir, cfg.scenarios) : null;
  return cfg;
}

/**
 * Разделяем «адаптера нет» и «адаптер сломан»: во втором случае бросаем,
 * иначе опечатка в адаптере выглядела бы как игра без симуляции и `all`
 * молча пропускал бы половину проверки.
 */
export async function loadAdapter(cfg) {
  if (!cfg.adapterFile) return null;
  if (!fs.existsSync(cfg.adapterFile)) throw new Error(`Адаптер не найден: ${cfg.adapterFile}`);
  const mod = await import(pathToFileURL(cfg.adapterFile).href + `?t=${Date.now()}`);
  const a = mod.default || mod;
  if (typeof a.install !== 'function') {
    throw new Error(`Адаптер ${cfg.adapterFile} должен экспортировать install() — см. adapters/ADAPTER.md`);
  }
  return a;
}

export async function loadScenarios(cfg) {
  if (!cfg.scenariosFile || !fs.existsSync(cfg.scenariosFile)) return [];
  const mod = await import(pathToFileURL(cfg.scenariosFile).href + `?t=${Date.now()}`);
  return mod.default || [];
}

/**
 * Полная обвязка: сервер + браузер + страница с игрой.
 * Возвращает всё, что нужно командам, и `dispose` для аккуратного закрытия.
 */
export async function boot(cfg, opts = {}) {
  const { viewport = cfg.viewport, headless = true, shell = false, seed = 1, adapter = null } = opts;
  // Имя вьюпорта проверяем до запуска чего бы то ни было: раньше опечатка
  // (в том числе в поле viewport сценария) роняла newPage уже после старта
  // сервера и браузера — и оба оставались висеть.
  viewportPreset(viewport);
  const server = await serve(cfg.rootDir);
  // Софтверный WebGL нужен только в headless, где иначе выйдет чёрный кадр.
  // В headed-режиме он бы отобрал ровно то, ради чего headed и запускают —
  // настоящий GPU.
  const browser = await launch({ headless, shell, swiftshader: headless && cfg.renderer === 'webgl' });
  const page = await newPage(browser, viewport);

  // Детерминизм ставим ДО загрузки игры: иначе первый же Math.random() уйдёт мимо.
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

/**
 * Инжектируется до загрузки страницы.
 * 1) сеет Math.random — без этого два прогона несравнимы и «фикс баланса» неверифицируем;
 * 2) даёт ручку паузы rAF, чтобы сим мог крутить логику без рендера.
 */
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

    /**
     * Оборачиваем каждый rAF-колбэк игры и засекаем, сколько он выполнялся.
     * Интервал МЕЖДУ кадрами при живом vsync равен периоду дисплея (8.3 мс на
     * 120 Гц) и о стоимости игры не говорит ничего — стоимость видна только
     * изнутри колбэка.
     */
    const timed = (cb) => (ts) => {
      const f = window.__forgeFrames;
      const t0 = performance.now();
      // inCb — «сейчас выполняется колбэк игры». Без этого признака любая
      // отрисовка на странице (setInterval, обработчик, накладной график)
      // засчитывалась бы игре, и рисующая менюшка ручалась бы за мёртвый
      // игровой цикл.
      if (f) f.inCb++;
      const leave = () => { if (f && f.inCb > 0) f.inCb--; };
      let async = false;
      try {
        const out = cb(ts);
        // `requestAnimationFrame(async loop)` заканчивается на первом await, а
        // рисует после него. Опустив флаг сразу, мы объявили бы такую игру
        // нерисующей. Держим кадр открытым до оседания промиса.
        if (out && typeof out.then === 'function') { async = true; out.then(leave, leave); }
      } finally {
        // Копим в pending, а закрываем кадр в tickProbe: два колбэка по 10 мс
        // в одном кадре — это кадр за 20 мс, а не два кадра по 10.
        // cbPending считает сами вызовы: кадр, в котором игра ничего не считала,
        // и кадр, в котором игра вообще не рисовала, — разные вещи.
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

    // Счётчик draw call'ов: для 3D это первый подозреваемый при просадке fps,
    // а получить его иначе можно только через дорогую трассировку.
    // Считаем ПОКАДРОВО: среднее прячет пик, а тормозит игра именно на пике —
    // один кадр с 600 вызовами при среднем 7 остаётся незамеченным.
    //
    // «Кадр игры» и «кадр, в котором игра рисовала» — разные вещи: пустой
    // `requestAnimationFrame(loop)` даёт полный набор кадров игры на намертво
    // застывшей картинке.
    //
    // Кадр помечается нарисованным при ДВУХ условиях: команда пришла изнутри
    // колбэка игры и адресована ТОМУ САМОМУ канвасу, который probe снимает
    // скриншотом. Иначе за мёртвый игровой канвас ручаются закадровый
    // бэкбуфер, соседний канвас с индикатором или помощник в стороне.
    //
    // Раньше здесь была «видимость» через clientWidth с кэшем — она врала в
    // обе стороны: канвас, показанный после загрузки, навсегда оставался
    // «невидимым», а `opacity: 0` считался видимым. Тождество с целью
    // скриншота однозначно, не требует лейаута и не расходится с тем, по
    // чему потом сравниваются пиксели.
    const gameCanvas = () => {
      let cv = window.__forgeCanvas;
      // Перезапрашиваем, только если канвас исчез из документа: игра могла
      // пересоздать его. Это чтение свойства, лейаут не дёргается.
      if (!cv || !cv.isConnected) {
        cv = document.querySelector(window.__forgeCanvasSel || 'canvas');
        window.__forgeCanvas = cv;
      }
      return cv;
    };
    // Флаг, а не счётчик: нужен факт, а не количество. Отметив кадр, дальше
    // выходим сразу — за каждый fillRect платить проверками незачем.
    const markPaint = (f, cv) => {
      if (!f || !f.inCb || !cv || f.painted) return;
      if (cv === gameCanvas()) f.painted = 1;
      // Игра рисует, но не туда, куда смотрит probe. Само по себе это не
      // приговор — это подсказка «укажи canvasSelector».
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
          // Счётчик draw call'ов считает ВСЁ (это нагрузка на GPU),
          // а признак отрисовки — только то, что видит игрок.
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

    // Три разных числа, которые легко перепутать:
    //   count     — кадры САМОЙ пробы: tickProbe крутится сам по себе и считает
    //               их, даже если игра не нарисовала ни одного кадра;
    //   gameFrames — кадры, в которых выполнялся rAF-колбэк ИГРЫ (вот это жизнь);
    //   times     — интервалы между кадрами, то есть каденс браузера (справочно).
    window.__forgeFrames = {
      count: 0, long: 0, times: [], last: 0, startedAt: 0,
      work: [], workTotal: 0, workMax: 0, pending: 0,
      gameFrames: 0, cbPending: 0, paintFrames: 0, painted: 0, inCb: 0, lastPaintAt: 0,
        otherPaintFrames: 0, paintedOther: 0,
      draws: [], drawsPending: 0, drawsMax: 0,
    };
    // tickProbe зарегистрирован первым, поэтому в каждом кадре он выполняется
    // раньше игровых колбэков — и закрывает работу ПРЕДЫДУЩЕГО кадра.
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

        // Кадр засчитывается игре, только если её колбэк в нём выполнялся.
        const cbs = f.cbPending;
        f.cbPending = 0;
        if (cbs > 0) f.gameFrames++;

        const frameDraws = f.drawsPending;
        f.drawsPending = 0;
        // Отрисовку помечают оба хука — и 2D, и WebGL, — поэтому здесь один
        // флаг. Сбрасывать его обязательно: иначе одна отрисовка помечает
        // нарисованными все последующие кадры.
        // lastPaintAt нужен, чтобы отличить «рисует редко» от «рисовал и
        // перестал»: доля кадров у этих двух случаев одинаковая.
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
