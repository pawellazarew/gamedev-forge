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
      const t0 = performance.now();
      try {
        cb(ts);
      } finally {
        const f = window.__forgeFrames;
        // Копим в pending, а закрываем кадр в tickProbe: два колбэка по 10 мс
        // в одном кадре — это кадр за 20 мс, а не два кадра по 10.
        // cbPending считает сами вызовы: кадр, в котором игра ничего не считала,
        // и кадр, в котором игра вообще не рисовала, — разные вещи.
        if (f) { f.pending += performance.now() - t0; f.cbPending++; }
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
    window.__forgeDraws = 0;
    for (const proto of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!proto) continue;
      for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const orig = proto.prototype[m];
        if (!orig) continue;
        proto.prototype[m] = function (...args) {
          window.__forgeDraws++;
          const f = window.__forgeFrames;
          if (f) f.drawsPending++;
          return orig.apply(this, args);
        };
      }
    }

    // «Кадр игры» и «кадр, в котором игра рисовала» — разные вещи: пустой
    // `requestAnimationFrame(loop)` даёт полный набор кадров игры на намертво
    // застывшей картинке. Отличить одно от другого можно только по командам
    // рисования, поэтому помечаем кадр, в котором канвас трогали.
    // Флаг, а не счётчик: нужен факт, а не количество, и платить за каждый
    // fillRect подсчётом незачем.
    for (const proto of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
      if (!proto) continue;
      for (const m of ['fillRect', 'strokeRect', 'clearRect', 'drawImage', 'fill', 'stroke',
        'fillText', 'strokeText', 'putImageData']) {
        const orig = proto.prototype[m];
        if (!orig) continue;
        proto.prototype[m] = function (...args) {
          const f = window.__forgeFrames;
          if (f) f.painted = 1;
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
      gameFrames: 0, cbPending: 0, paintFrames: 0, painted: 0,
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
        // Отрисовка — команды 2D-канваса ИЛИ draw call'ы WebGL.
        if (f.painted || frameDraws > 0) f.paintFrames++;
        f.painted = 0;
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
        gameFrames: 0, cbPending: 0, paintFrames: 0, painted: 0,
        draws: [], drawsPending: 0, drawsMax: 0,
      };
      window.__forgeDraws = 0;
    };
  };
}
