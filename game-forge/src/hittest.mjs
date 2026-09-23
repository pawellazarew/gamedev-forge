import { viewport as viewportPreset } from './browser.mjs';

/**
 * «Попадёт ли по элементу настоящий игрок». DOM-клик — `el.click()`,
 * `__b2b.clickCode()`, `dispatchEvent` — доходит до обработчика сквозь любой
 * слой сверху, и сценарий зеленеет на игре, в которой нельзя нажать ни одной
 * кнопки. Так было с bum2billionaire 2026-09-23: `#art { z-index: 3 }` накрыл
 * кнопку кода и магазин, а play отчитался 15/15, хотя на собственных кадрах
 * forge висела пустая панель магазина.
 *
 * Проверка повторяет то, что делает браузер при настоящем клике: берёт центр
 * видимой части элемента и спрашивает `elementFromPoint`, кто там сверху.
 */

/** Ошибка «по элементу не попасть» — сценарий по ней снимает кадр с перекрытием. */
export class HitError extends Error {}

/**
 * Сколько проверка в конце сценария ждёт, пока элементы освободятся:
 * переходы и затухания оверлеев короче. Меняется `hittable.settleMs`.
 */
export const HIT_SETTLE_MS = 1000;
/**
 * Сколько клик ждёт, пока элемент появится, освободится и включится.
 * 30 с Playwright — это полминуты на каждую опечатку. Меняется `timeout` шага.
 */
export const WAIT_VISIBLE_MS = 5000;
/** Вьюпорты, на которых раскладка ломается по-разному; по умолчанию проверяем все три. */
export const DEFAULT_HIT_VIEWPORTS = ['desktop', 'phoneLandscape', 'phone'];

/**
 * Выполняется в странице, поэтому самодостаточна: никаких замыканий на модуль.
 * Элементы приходят из движка селекторов Playwright, а не из второго
 * `querySelector`: тот не пробивал бы shadow DOM и мог найти не тот элемент.
 *
 * Берётся первый ВИДИМЫЙ элемент по селектору: карточки неактивной вкладки и
 * спрятанные шаблоны идут в DOM раньше и валили бы проверку ложно.
 *
 * Три системы координат, которые легко спутать:
 *   - клиентские (getBoundingClientRect, elementFromPoint) — от лэйаут-вьюпорта;
 *   - экран игрока — visual viewport: на телефоне страница шире экрана, и
 *     видна только его часть со сдвигом offsetLeft/offsetTop;
 *   - координаты ввода Playwright — от левого верхнего угла visual viewport.
 * Считать «видимое» по innerWidth нельзя: на широкой странице кнопка за
 * краем экрана проходила проверку, а касание уходило мимо неё без ошибки.
 */
function probeHit(els, opts) {
  const describe = (n) => {
    if (!n) return null;
    if (n.nodeType !== 1) return String(n.nodeName).toLowerCase();
    let s = n.tagName.toLowerCase();
    if (n.id) s += `#${n.id}`;
    // У SVG className — объект, а не строка
    const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += `.${cls.slice(0, 3).join('.')}`;
    return s;
  };
  // Слой, в котором лежит узел: ближайший предок с позиционированием и
  // явным z-index. Именно он решает, кто сверху, и именно его чинят.
  const layerOf = (n) => {
    for (let cur = n; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (cs.position !== 'static' && cs.zIndex !== 'auto') return { el: describe(cur), z: cs.zIndex };
    }
    return null;
  };
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    return e.isConnected && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  };

  if (!els.length) return { ok: false, reason: 'missing' };
  const el = els.find(shown);
  if (!el) {
    const r = els[0].getBoundingClientRect();
    return {
      ok: false, reason: 'invisible', w: Math.round(r.width), h: Math.round(r.height),
      visibility: getComputedStyle(els[0]).visibility, count: els.length,
    };
  }

  const HIDE = /^(hidden|clip)$/;
  const vv = window.visualViewport;
  const view = () => (vv
    ? { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height }
    : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  // Прокрутку всего окна задаёт overflow у html, а если там visible — у body
  const docOverflow = () => {
    const html = getComputedStyle(document.documentElement);
    if (html.overflowX !== 'visible' || html.overflowY !== 'visible' || !document.body) {
      return { cs: html, el: document.documentElement };
    }
    return { cs: getComputedStyle(document.body), el: document.body };
  };
  // Контейнеры, которые обрезают элемент: предки с overflow не visible
  const clippers = () => {
    const out = [];
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push({ a, cs });
    }
    return out;
  };
  // Видимая часть: сам элемент ∩ обрезающие предки ∩ экран игрока. Центр
  // берётся по ней: у панели выше экрана или строки в прокручиваемом списке
  // геометрический центр может лежать там, куда игрок не видит.
  const visible = () => {
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    for (const { a, cs } of clippers()) {
      const ar = a.getBoundingClientRect();
      if (cs.overflowX !== 'visible') { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
      if (cs.overflowY !== 'visible') { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
    }
    const v = view();
    left = Math.max(left, v.x); top = Math.max(top, v.y);
    right = Math.min(right, v.x + v.w); bottom = Math.min(bottom, v.y + v.h);
    return { r, v, box: right > left && bottom > top ? { left, top, right, bottom } : null };
  };

  let { r, v, box } = visible();
  const w = Math.round(r.width), h = Math.round(r.height);
  if (!box && opts.scroll) {
    // Докручиваем, как докрутил бы игрок. Но программно scrollIntoView
    // крутит и контейнеры с overflow: hidden, куда игрок не докрутит, —
    // тогда проверка зеленела бы на уехавшей за край кнопке. Запоминаем
    // прокрутку запертых контейнеров, и если она сдвинулась, возвращаем её
    // назад и говорим, кто заперт.
    const locks = clippers().filter(({ cs }) => HIDE.test(cs.overflowX) || HIDE.test(cs.overflowY))
      .map(({ a, cs }) => ({ a, x: HIDE.test(cs.overflowX), y: HIDE.test(cs.overflowY) }));
    const dov = docOverflow();
    const se = document.scrollingElement;
    if (se && (HIDE.test(dov.cs.overflowX) || HIDE.test(dov.cs.overflowY))) {
      locks.push({ a: se, x: HIDE.test(dov.cs.overflowX), y: HIDE.test(dov.cs.overflowY), owner: dov.el });
    }
    for (const l of locks) { l.left = l.a.scrollLeft; l.top = l.a.scrollTop; }
    // instant: при `scroll-behavior: smooth` прокрутка иначе асинхронна,
    // и проверка смотрела бы на середину анимации
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const moved = locks.find((l) => (l.x && l.a.scrollLeft !== l.left) || (l.y && l.a.scrollTop !== l.top));
    if (moved) {
      for (const l of locks) { l.a.scrollLeft = l.left; l.a.scrollTop = l.top; }
      ({ r, v } = visible());
      return {
        ok: false, reason: 'offscreen', w, h, rect: [Math.round(r.left), Math.round(r.top)],
        vw: Math.round(v.w), vh: Math.round(v.h), locked: describe(moved.owner || moved.a),
      };
    }
    ({ r, v, box } = visible());
  }
  if (!box) {
    return { ok: false, reason: 'offscreen', w, h, rect: [Math.round(r.left), Math.round(r.top)], vw: Math.round(v.w), vh: Math.round(v.h) };
  }

  const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
  // Ввод — от угла экрана игрока, а не от лэйаут-вьюпорта
  const at = { x, y, ix: x - v.x, iy: y - v.y, w, h };
  const cs = getComputedStyle(el);
  if (cs.pointerEvents === 'none') return { ok: false, reason: 'no-pointer-events', ...at };

  const root = el.getRootNode();
  const hit = (typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(x, y);
  // Выключенная кнопка лежит сверху и hit-test проходит, но клик по ней
  // ничего не делает: для перекрытия это не провал, для клика — провал.
  const disabled = el.matches(':disabled');
  if (hit && (hit === el || el.contains(hit))) return { ok: true, disabled, ...at };
  const owner = hit && !hit.id && hit.parentElement ? hit.parentElement.closest('[id]') : null;
  return {
    ok: false, reason: 'covered', ...at, disabled,
    hit: describe(hit),
    owner: describe(owner),
    layer: hit ? layerOf(hit) : null,
    self: layerOf(el),
  };
}

/**
 * Одна проверка без ожидания: `{ ok, reason, x, y, ix, iy, … }`.
 * scroll: докрутить к элементу, если игрок может это сделать сам.
 */
export async function hitTest(page, selector, { scroll = true } = {}) {
  try {
    return await page.locator(selector).evaluateAll(probeHit, { scroll });
  } catch (err) {
    const msg = String(err?.message || err).split('\n')[0];
    // Опечатка в селекторе — не то же самое, что «элемента нет»
    if (/selector|parse|Unexpected token/i.test(msg)) return { ok: false, reason: 'bad-selector', error: msg };
    // Элемент пересоздали посреди проверки — это «не нашли», а не падение прогона
    return { ok: false, reason: 'detached', error: msg };
  }
}

/**
 * Проверять, пока все элементы не пройдут `accept` или не выйдет срок.
 * Разовый снимок ловил бы середину затухания модалки; постоянное перекрытие
 * от ожидания не лечится и падает так же, только позже.
 */
export async function waitHittable(page, selectors, settleMs = HIT_SETTLE_MS, accept = (r) => r.ok) {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const results = [];
    for (const sel of selectors) results.push({ selector: sel, ...(await hitTest(page, sel)) });
    if (results.every(accept) || Date.now() >= deadline) return results;
    await page.waitForTimeout(100);
  }
}

const px = (v) => Math.round(v);

/** Человеческое объяснение провала: что именно мешает и что чинить. */
export function hitMessage(selector, res) {
  const s = `«${selector}»`;
  switch (res.reason) {
    case 'missing': return `${s} не найден на странице`;
    case 'bad-selector': return `${s} — неверный селектор: ${res.error}`;
    case 'detached': return `${s} пропал из документа во время проверки`;
    case 'invisible':
      return `${s} не виден: ${res.w}×${res.h}${res.visibility === 'hidden' ? ', visibility: hidden' : ''}`
        + (res.count > 1 ? ` (спрятаны все ${res.count} совпадения)` : '');
    case 'offscreen':
      return `${s} за экраном игрока: левый верхний угол (${res.rect[0]}, ${res.rect[1]}), `
        + `размер ${res.w}×${res.h} при экране ${res.vw}×${res.vh}`
        + (res.locked ? `, и докрутить туда нельзя — overflow: hidden у ${res.locked}` : '');
    case 'no-pointer-events':
      return `${s} не принимает клики: у самого элемента pointer-events: none`;
    case 'disabled':
      return `${s} выключен (disabled) — настоящий клик ничего бы не сделал`;
    case 'covered': {
      const top = res.hit
        ? res.owner ? `${res.hit} внутри ${res.owner}` : res.hit
        : 'пустота (точка вне документа)';
      const layer = res.layer ? ` (слой ${res.layer.el}, z-index ${res.layer.z})` : '';
      const self = res.self ? `z-index ${res.self.z} у ${res.self.el}` : 'своего z-index нет';
      return `${s} перекрыт: в точке (${px(res.x)}, ${px(res.y)}) сверху ${top}${layer}, у ${s} ${self} — `
        + 'настоящий клик игрока уйдёт в перекрывающий элемент';
    }
    default: return `${s} недоступен для клика (${res.reason})`;
  }
}

/** Бросает с понятным сообщением, если по элементу не попасть. */
export async function assertHittable(page, selector, { settleMs = HIT_SETTLE_MS } = {}) {
  const [res] = await waitHittable(page, [selector], settleMs);
  if (!res.ok) throw new HitError(hitMessage(selector, res));
  return res;
}

/**
 * Проверки в формате сценария: по одной на селектор, провал не бросает.
 * kind: 'hittable' отличает их от expect — в probe перекрытие — находка, а
 * не сорванная подготовка сцены.
 */
export async function hittableChecks(page, selectors, settleMs = HIT_SETTLE_MS) {
  const results = await waitHittable(page, selectors, settleMs);
  return results.map((r) => ({
    name: `кликабелен «${r.selector}»`,
    status: r.ok ? 'pass' : 'fail',
    detail: r.ok ? '' : hitMessage(r.selector, r),
    kind: 'hittable',
    selector: r.selector,
  }));
}

/** Одна проверка для probe: там у проверок короткие имена и одна строка на гейт. */
export function hittableSummary(checks) {
  const failed = checks.filter((c) => c.status === 'fail');
  const sels = [...new Set(checks.map((c) => c.selector).filter(Boolean))];
  return {
    name: 'hittable',
    status: failed.length ? 'fail' : 'pass',
    detail: failed.length ? failed.map((c) => c.detail).join(' | ') : `кликабельны: ${sels.join(', ')}`,
  };
}

/**
 * Клик как у игрока: дождаться, пока элемент появится, окажется сверху и
 * включится (докрутив к нему, если игрок может), и нажать настоящим вводом —
 * мышью на десктопе, пальцем там, где у вьюпорта есть тач. Каждый клик
 * проверяется заново: слой, накрывающий кнопку после первого нажатия, —
 * ровно та поломка, ради которой всё это написано.
 */
export async function realClick(page, selector, { timeout = WAIT_VISIBLE_MS, times = 1 } = {}) {
  const touch = !!page.__forgeTouch;
  let last = null;
  for (let n = 1; n <= times; n++) {
    const [res] = await waitHittable(page, [selector], timeout, (r) => r.ok && !r.disabled);
    if (!res.ok || res.disabled) {
      const why = hitMessage(selector, res.ok ? { reason: 'disabled' } : res);
      throw new HitError(`${why} — ждали ${timeout} мс${times > 1 ? ` (клик ${n} из ${times})` : ''}`);
    }
    if (touch) await page.touchscreen.tap(res.ix, res.iy);
    else await page.mouse.click(res.ix, res.iy);
    last = { x: res.ix, y: res.iy, input: touch ? 'touch' : 'mouse' };
  }
  return last;
}

/**
 * Секция `hittable` конфига в одну форму. Короткая запись — массив
 * селекторов. Ошибки формы бросаем при загрузке: опечатка в имени вьюпорта
 * иначе всплыла бы посреди прогона, а пустой список тихо выключил бы защиту.
 */
export function normalizeHittable(raw) {
  if (raw == null || raw === false) return null;
  const obj = Array.isArray(raw) ? { selectors: raw } : raw;
  if (typeof obj !== 'object') throw new Error('hittable: ожидается массив селекторов или { selectors, viewports, setup, settleMs }');
  const selectors = obj.selectors;
  if (!Array.isArray(selectors) || !selectors.length || !selectors.every((s) => typeof s === 'string' && s.trim())) {
    throw new Error('hittable.selectors: нужен непустой массив CSS-селекторов');
  }
  const viewports = obj.viewports ?? DEFAULT_HIT_VIEWPORTS;
  if (!Array.isArray(viewports)) throw new Error('hittable.viewports: ожидается массив имён вьюпортов');
  for (const vp of viewports) viewportPreset(vp);
  const setup = obj.setup ?? [];
  if (!Array.isArray(setup)) throw new Error('hittable.setup: ожидается массив шагов сценария');
  const settleMs = obj.settleMs ?? HIT_SETTLE_MS;
  if (!Number.isFinite(settleMs) || settleMs < 0) throw new Error('hittable.settleMs: ожидается число миллисекунд ≥ 0');
  return { selectors, viewports, setup, settleMs };
}

/** Сколько ждать освобождения элементов в проверке: конфиг или умолчание. */
export function settleOf(cfg) {
  return cfg?.hittable?.settleMs ?? HIT_SETTLE_MS;
}

/** Какие селекторы проверять в конце сценария: сценарий может сузить список или отказаться. */
export function hittableFor(sc, cfg) {
  if (sc?.hittable === false) return [];
  if (Array.isArray(sc?.hittable)) return sc.hittable;
  return cfg?.hittable?.selectors || [];
}

/**
 * Сценарии обхода по вьюпортам: игра поднимается заново, выполняет
 * `hittable.setup` и в конце проверяется обычным порядком. Нужны, чтобы
 * «кликабельно на телефоне» проверялось, даже если все сценарии игры
 * десктопные.
 */
export function sweepScenarios(cfg, explicitViewport = null) {
  const h = cfg?.hittable;
  if (!h || !h.selectors.length) return [];
  // Явный --viewport перебивает вьюпорт любого сценария — три одинаковых
  // прогона подряд ничего бы не добавили.
  const vps = explicitViewport ? [explicitViewport] : h.viewports;
  return vps.map((vp) => ({
    name: `hittable@${vp}`,
    viewport: vp,
    note: `Обход «должно оставаться кликабельным» (${vp}): ${h.selectors.join(', ')}`,
    steps: h.setup,
    builtin: true,
  }));
}
