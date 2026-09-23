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

/** Сколько ждём, пока элемент освободится: переходы и затухания оверлеев короче. */
export const HIT_SETTLE_MS = 1000;
/** Сколько ждём появления элемента перед кликом. 30 с Playwright — это полминуты на опечатку. */
export const WAIT_VISIBLE_MS = 5000;
/** Вьюпорты, на которых раскладка ломается по-разному; по умолчанию проверяем все три. */
export const DEFAULT_HIT_VIEWPORTS = ['desktop', 'phoneLandscape', 'phone'];

/**
 * Выполняется в странице, поэтому самодостаточна: никаких замыканий на модуль.
 * Элемент приходит хэндлом Playwright, а не селектором — второй
 * `querySelector` внутри страницы не пробивал бы shadow DOM и мог найти
 * другой элемент, чем тот, по которому потом кликнет мышь.
 */
function probeHit(el) {
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

  if (!el.isConnected) return { ok: false, reason: 'detached' };
  const r = el.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  const cs = getComputedStyle(el);
  if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') {
    return { ok: false, reason: 'invisible', w, h, visibility: cs.visibility };
  }
  // Центр ВИДИМОЙ части: у панели выше экрана геометрический центр может
  // оказаться за краем, хотя игрок по ней попадает.
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.max(r.left, 0), top = Math.max(r.top, 0);
  const right = Math.min(r.right, vw), bottom = Math.min(r.bottom, vh);
  if (right <= left || bottom <= top) {
    return { ok: false, reason: 'offscreen', w, h, rect: [Math.round(r.left), Math.round(r.top)], vw, vh };
  }
  const x = (left + right) / 2, y = (top + bottom) / 2;
  if (cs.pointerEvents === 'none') return { ok: false, reason: 'no-pointer-events', x, y, w, h };

  const root = el.getRootNode();
  const hit = (typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(x, y);
  const ok = !!hit && (hit === el || el.contains(hit));
  if (ok) return { ok: true, x, y, w, h };
  const owner = hit && !hit.id && hit.parentElement ? hit.parentElement.closest('[id]') : null;
  return {
    ok: false, reason: 'covered', x, y, w, h,
    hit: describe(hit),
    owner: describe(owner),
    layer: hit ? layerOf(hit) : null,
    self: layerOf(el),
  };
}

/** Одна проверка без ожидания: `{ ok, reason, x, y, … }`. */
export async function hitTest(page, selector) {
  let el;
  try {
    el = await page.$(selector);
  } catch (err) {
    return { ok: false, reason: 'bad-selector', error: String(err?.message || err).split('\n')[0] };
  }
  if (!el) return { ok: false, reason: 'missing' };
  try {
    return await el.evaluate(probeHit);
  } catch (err) {
    // Элемент пересоздали между поиском и проверкой — это «не нашли», а не падение прогона
    return { ok: false, reason: 'detached', error: String(err?.message || err).split('\n')[0] };
  } finally {
    await el.dispose().catch(() => {});
  }
}

/**
 * Проверять, пока элементы не освободятся или не выйдет срок. Разовый снимок
 * ловил бы середину затухания модалки; постоянное перекрытие от ожидания не
 * лечится и падает так же, только на секунду позже.
 */
export async function waitHittable(page, selectors, settleMs = HIT_SETTLE_MS) {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const results = [];
    for (const sel of selectors) results.push({ selector: sel, ...(await hitTest(page, sel)) });
    if (results.every((r) => r.ok) || Date.now() >= deadline) return results;
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
      return `${s} не виден: ${res.w}×${res.h}${res.visibility === 'hidden' ? ', visibility: hidden' : ''}`;
    case 'offscreen':
      return `${s} целиком за экраном: левый верхний угол (${res.rect[0]}, ${res.rect[1]}), `
        + `размер ${res.w}×${res.h} при экране ${res.vw}×${res.vh}`;
    case 'no-pointer-events':
      return `${s} не принимает клики: у самого элемента pointer-events: none`;
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

/** Проверки в формате сценария: по одной на селектор, провал не бросает. */
export async function hittableChecks(page, selectors, settleMs = HIT_SETTLE_MS) {
  const results = await waitHittable(page, selectors, settleMs);
  return results.map((r) => ({
    name: `кликабелен «${r.selector}»`,
    status: r.ok ? 'pass' : 'fail',
    detail: r.ok ? '' : hitMessage(r.selector, r),
  }));
}

/** Одна проверка для probe: там у проверок короткие имена и одна строка на гейт. */
export function hittableSummary(selectors, checks) {
  const failed = checks.filter((c) => c.status === 'fail');
  return {
    name: 'hittable',
    status: failed.length ? 'fail' : 'pass',
    detail: failed.length ? failed.map((c) => c.detail).join(' | ') : `кликабельны: ${selectors.join(', ')}`,
  };
}

/**
 * Клик как у игрока: элемент дождаться, прокрутить к нему, проверить, что
 * сверху лежит именно он, и нажать настоящим вводом — мышью на десктопе,
 * пальцем там, где у вьюпорта есть тач. Каждый клик проверяется заново:
 * слой, накрывающий кнопку после первого нажатия, — ровно та поломка, ради
 * которой всё это написано.
 */
export async function realClick(page, selector, { timeout = WAIT_VISIBLE_MS, settleMs = HIT_SETTLE_MS, times = 1 } = {}) {
  const touch = !!page.__forgeTouch;
  let last = null;
  for (let n = 1; n <= times; n++) {
    const nth = times > 1 ? ` (клик ${n} из ${times})` : '';
    const el = await page.waitForSelector(selector, { state: 'visible', timeout }).catch(() => null);
    if (!el) {
      const res = await hitTest(page, selector);
      const why = res.ok || res.reason === 'covered' ? `«${selector}» так и не стал видимым` : hitMessage(selector, res);
      throw new HitError(`${why} за ${timeout} мс${nth}`);
    }
    await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await el.dispose().catch(() => {});
    const [res] = await waitHittable(page, [selector], settleMs);
    if (!res.ok) throw new HitError(hitMessage(selector, res) + nth);
    if (touch) await page.touchscreen.tap(res.x, res.y);
    else await page.mouse.click(res.x, res.y);
    last = { x: res.x, y: res.y, input: touch ? 'touch' : 'mouse' };
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
  if (typeof obj !== 'object') throw new Error('hittable: ожидается массив селекторов или { selectors, viewports, setup }');
  const selectors = obj.selectors;
  if (!Array.isArray(selectors) || !selectors.length || !selectors.every((s) => typeof s === 'string' && s.trim())) {
    throw new Error('hittable.selectors: нужен непустой массив CSS-селекторов');
  }
  const viewports = obj.viewports ?? DEFAULT_HIT_VIEWPORTS;
  if (!Array.isArray(viewports)) throw new Error('hittable.viewports: ожидается массив имён вьюпортов');
  for (const vp of viewports) viewportPreset(vp);
  const setup = obj.setup ?? [];
  if (!Array.isArray(setup)) throw new Error('hittable.setup: ожидается массив шагов сценария');
  return { selectors, viewports, setup };
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
