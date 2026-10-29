import { viewport as viewportPreset } from './browser.mjs';

/** Test whether a real player can reach a control. DOM calls such as el.click(),
 * __b2b.clickCode() and dispatchEvent bypass overlays. In bum2billionaire on
 * 2026-09-23, #art { z-index: 3 } covered the code button and shop, yet play
 * passed 15/15 while screenshots showed an empty shop panel.
 * Match real browser hit testing: use the visible center of the element
 * and ask elementFromPoint which node is on top. */

/** Unreachable-element error; scenario code captures the covering layer. */
export class HitError extends Error {}

/** End-of-scenario wait for overlays/transitions to clear; set hittable.settleMs. */
export const HIT_SETTLE_MS = 1000;
/** Wait for an element to appear, become uncovered and enabled.
 * Use the step timeout instead of Playwright's 30-second wait per typo. */
export const WAIT_VISIBLE_MS = 5000;
/** Layout failures differ across these viewports; check all three by default. */
export const DEFAULT_HIT_VIEWPORTS = ['desktop', 'phoneLandscape', 'phone'];

/** Runs inside the page and must have no module closures. Elements come from
 * Playwright's selector engine, which pierces shadow DOM, unlike another
 * document.querySelector lookup. Use the first visible match so hidden
 * templates and inactive tabs cannot cause false failures.
 * Coordinate spaces differ: getBoundingClientRect and elementFromPoint use
 * the layout viewport; the player sees the visual viewport with its offsets;
 * Playwright input is relative to the visual viewport origin. innerWidth
 * can include offscreen content on mobile and falsely accept an unreachable tap. */
function probeHit(els, opts) {
  const describe = (n) => {
    if (!n) return null;
    if (n.nodeType !== 1) return String(n.nodeName).toLowerCase();
    let s = n.tagName.toLowerCase();
    if (n.id) s += `#${n.id}`;
    // SVG className is an object rather than a string.
    const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += `.${cls.slice(0, 3).join('.')}`;
    return s;
  };
  // Walk the flattened parent tree through slots and shadow roots.
  // parentElement alone misses scroll containers around web components.
  const up = (n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null;
  // The relevant layer is the nearest positioned ancestor with explicit
  // z-index: it controls stacking and is the layer the developer should fix.
  const layerOf = (n) => {
    for (let cur = n; cur && cur.nodeType === 1; cur = up(cur)) {
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
  // Viewport overflow comes from html, or body when html overflow is visible.
  const docOverflow = () => {
    const html = getComputedStyle(document.documentElement);
    if (html.overflowX !== 'visible' || html.overflowY !== 'visible' || !document.body) {
      return { cs: html, el: document.documentElement };
    }
    return { cs: getComputedStyle(document.body), el: document.body };
  };
  // With html/body overflow:hidden, scrollingElement is html but body can
  // scroll. Snapshot both so body scroll can be restored.
  const atTop = (a) => !a || a === document.documentElement;
  // Body overflow propagates to the viewport only while html overflow is
  // visible. With fullscreen html/body overflow:hidden, body is its own
  // scroll container and must not be skipped when testing reachability.
  const htmlVisible = () => {
    const cs = getComputedStyle(document.documentElement);
    return cs.overflowX === 'visible' && cs.overflowY === 'visible';
  };
  // Whether the node establishes a containing block for fixed and absolute descendants.
  const makesCB = (cs) => cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none'
    || (cs.backdropFilter && cs.backdropFilter !== 'none')
    || /paint|layout|strict|content/.test(cs.contain || '') || /transform|perspective|filter/.test(cs.willChange || '');
  // Only the containing block and its ancestors clip an element. A fixed
  // button is not clipped by centered #game overflow; an absolute button is
  // not clipped by a non-positioned wrapper. Otherwise both look offscreen.
  const containingBlock = (n) => {
    const pos = getComputedStyle(n).position;
    let a = up(n);
    if (pos === 'fixed') {
      while (!atTop(a) && !makesCB(getComputedStyle(a))) a = up(a);
    } else if (pos === 'absolute') {
      while (!atTop(a)) {
        const cs = getComputedStyle(a);
        if (cs.position !== 'static' || makesCB(cs)) break;
        a = up(a);
      }
    }
    return atTop(a) ? null : a;
  };
  const clippers = () => {
    const out = [];
    for (let a = containingBlock(el); a; a = containingBlock(a)) {
      // docOverflow handles body overflow propagated to the viewport.
      if (a === document.body && htmlVisible()) continue;
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push({ a, cs });
    }
    return out;
  };
  // Visible area = element intersected with clipping containers and the player
  // viewport. Use its center; the geometric center of an oversized panel or
  // partly visible list row may lie outside the player's view.
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
  // Snapshot container/page scrolling and mark axes locked by hidden/clip.
  // Scripts can scroll these axes but a player cannot.
  const scrollState = () => {
    const list = clippers().map(({ a, cs }) => ({ a, x: HIDE.test(cs.overflowX), y: HIDE.test(cs.overflowY) }));
    const se = document.scrollingElement;
    if (se) {
      const d = docOverflow();
      list.push({ a: se, x: HIDE.test(d.cs.overflowX), y: HIDE.test(d.cs.overflowY), owner: d.el });
    }
    // Body can be its own scroll container (see htmlVisible); record it
    // even when it was not encountered as a clipping ancestor.
    const body = document.body;
    if (body && body !== se && !htmlVisible() && !list.some((st) => st.a === body)) {
      const cs = getComputedStyle(body);
      list.push({ a: body, x: HIDE.test(cs.overflowX), y: HIDE.test(cs.overflowY) });
    }
    for (const st of list) { st.left = st.a.scrollLeft; st.top = st.a.scrollTop; }
    return list;
  };

  let { r, v, box } = visible();
  const w = Math.round(r.width), h = Math.round(r.height);
  let saved = null, locked = null;
  if (!box && opts.scroll) {
    // Scroll like a player. inline:nearest leaves an already-visible horizontal
    // position intact, avoiding false locked-axis failures in overflow-x:hidden
    // lists. instant avoids asynchronous scroll-behavior:smooth movement.
    saved = scrollState();
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    // Restore only locked axes. A player could move the unlocked axes; assess
    // what remains visible afterward.
    for (const st of saved) {
      if (st.x && st.a.scrollLeft !== st.left) { st.a.scrollLeft = st.left; locked = locked || st; }
      if (st.y && st.a.scrollTop !== st.top) { st.a.scrollTop = st.top; locked = locked || st; }
    }
    ({ r, v, box } = visible());
  }

  const judge = () => {
    if (!box) {
      return {
        ok: false, reason: 'offscreen', w, h, rect: [Math.round(r.left), Math.round(r.top)],
        vw: Math.round(v.w), vh: Math.round(v.h), locked: locked ? describe(locked.owner || locked.a) : null,
      };
    }
    const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
    // Input coordinates use the player viewport origin, not the layout viewport.
    const at = { x, y, ix: x - v.x, iy: y - v.y, w, h };
    if (getComputedStyle(el).pointerEvents === 'none') return { ok: false, reason: 'no-pointer-events', ...at };

    const root = el.getRootNode();
    const hit = (typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(x, y);
    // A disabled button can be on top and pass hit testing but cannot be
    // activated: disabled is acceptable for an overlay check, not for a click.
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
  };
  const res = judge();
  // Pure checks restore scrolling; clicks retain it to hit the scrolled-to
  // position. Mobile visual-viewport panning has no restoration API.
  if (opts.restore && saved) {
    const changed = saved.some((st) => st.a.scrollLeft !== st.left || st.a.scrollTop !== st.top);
    for (const st of saved) { st.a.scrollLeft = st.left; st.a.scrollTop = st.top; }
    // Scrolling out and back still emits scroll/scrollend next frame. Suppress
    // only restored-container events that arrive while the container remains
    // at its restored position. A genuine next-step scroll may share the event
    // but moves the container and must reach the game.
    if (changed) {
      const stop = (e) => {
        const t = e.target === document ? document.scrollingElement : e.target;
        const st = saved.find((x) => x.a === t);
        if (st && t.scrollLeft === st.left && t.scrollTop === st.top) e.stopImmediatePropagation();
      };
      for (const t of ['scroll', 'scrollend']) window.addEventListener(t, stop, true);
      setTimeout(() => { for (const t of ['scroll', 'scrollend']) window.removeEventListener(t, stop, true); }, 100);
    }
  }
  return res;
}

/** One immediate check: { ok, reason, x, y, ix, iy, ... }.
 * scroll allows player-reachable scrolling; restore returns to the prior position. */
export async function hitTest(page, selector, { scroll = true, restore = false } = {}) {
  try {
    return await page.locator(selector).evaluateAll(probeHit, { scroll, restore });
  } catch (err) {
    const msg = String(err?.message || err).split('\n')[0];
    // An invalid selector is different from an absent element.
    if (/while parsing|SyntaxError|not a valid|Unknown engine/i.test(msg)) return { ok: false, reason: 'bad-selector', error: msg };
    // An element recreated during the check is missing, not a crashed run.
    return { ok: false, reason: 'detached', error: msg };
  }
}

/** Retry until every element passes accept or the deadline expires. A single
 * snapshot may catch a fading modal; persistent overlays still fail after
 * the wait. Invalid selectors cannot recover and fail immediately. */
export async function waitHittable(page, selectors, { settleMs = HIT_SETTLE_MS, accept = (r) => r.ok, restore = false } = {}) {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const results = [];
    for (const sel of selectors) results.push({ selector: sel, ...(await hitTest(page, sel, { restore })) });
    if (results.every(accept) || results.some((r) => r.reason === 'bad-selector') || Date.now() >= deadline) return results;
    await page.waitForTimeout(100);
  }
}

const px = (v) => Math.round(v);

/** Human-readable failure explanation identifying the obstruction and repair target. */
export function hitMessage(selector, res) {
  const s = `«${selector}»`;
  switch (res.reason) {
    case 'missing': return `${s} not found on the page`;
    case 'bad-selector': return `${s} — invalid selector: ${res.error}`;
    case 'detached': return `${s} was detached during the check`;
    case 'invisible':
      return `${s} not visible: ${res.w}×${res.h}${res.visibility === 'hidden' ? ', visibility: hidden' : ''}`
        + (res.count > 1 ? ` (all ${res.count} matches are hidden)` : '');
    case 'offscreen':
      return `${s} outside the player viewport: top-left (${res.rect[0]}, ${res.rect[1]}), `
        + `size ${res.w}×${res.h}, viewport ${res.vw}×${res.vh}`
        + (res.locked ? `, cannot scroll there; overflow: hidden on ${res.locked}` : '');
    case 'no-pointer-events':
      return `${s} cannot receive clicks: the element has pointer-events: none`;
    case 'disabled':
      return `${s} is disabled; a real click would have no effect`;
    case 'covered': {
      const top = res.hit
        ? res.owner ? `${res.hit} inside ${res.owner}` : res.hit
        : 'nothing (point outside the document)';
      const layer = res.layer ? ` (layer ${res.layer.el}, z-index ${res.layer.z})` : '';
      const self = res.self ? `z-index ${res.self.z} on ${res.self.el}` : 'no explicit z-index';
      return `${s} is covered: at (${px(res.x)}, ${px(res.y)}), ${top}${layer} is on top; ${s} has ${self}; `
        + 'a real player click would hit the covering element';
    }
    default: return `${s} cannot be clicked (${res.reason})`;
  }
}

/** Throw a clear diagnostic when an element is unreachable. */
export async function assertHittable(page, selector, { settleMs = HIT_SETTLE_MS } = {}) {
  const [res] = await waitHittable(page, [selector], { settleMs, restore: true });
  if (!res.ok) throw new HitError(hitMessage(selector, res));
  return res;
}

/** One scenario-format check per selector; failures do not throw.
 * kind:hittable distinguishes findings from expect failures so probe can
 * report an overlay without cancelling scene preparation. */
export async function hittableChecks(page, selectors, settleMs = HIT_SETTLE_MS, { keepOnFail = false } = {}) {
  // Restore scrolling for checks both mid-scenario and at its end; otherwise
  // probe would measure a scrolled scene.
  const results = await waitHittable(page, selectors, { settleMs, restore: true });
  // keepOnFail scrolls back to the first failed element so the failure frame
  // shows the obstruction at the reported coordinates. The scenario is
  // already failed at this point.
  const firstFail = results.find((r) => !r.ok);
  if (keepOnFail && firstFail) await hitTest(page, firstFail.selector, { restore: false });
  return results.map((r) => ({
    name: `hittable «${r.selector}»`,
    status: r.ok ? 'pass' : 'fail',
    detail: r.ok ? '' : hitMessage(r.selector, r),
    kind: 'hittable',
    selector: r.selector,
  }));
}

/** One compact probe gate with a short name and a single diagnostic line. */
export function hittableSummary(checks) {
  const failed = checks.filter((c) => c.status === 'fail');
  const sels = [...new Set(checks.map((c) => c.selector).filter(Boolean))];
  return {
    name: 'hittable',
    status: failed.length ? 'fail' : 'pass',
    detail: failed.length ? failed.map((c) => c.detail).join(' | ') : `hittable: ${sels.join(', ')}`,
  };
}

/** Player-style click: wait for a visible, uncovered, enabled element, scroll
 * only where the player could, then use mouse input or a viewport touch.
 * Recheck every click so an overlay appearing after the first press is caught. */
export async function realClick(page, selector, { timeout = WAIT_VISIBLE_MS, times = 1 } = {}) {
  const touch = !!page.__forgeTouch;
  let last = null;
  for (let n = 1; n <= times; n++) {
    const [res] = await waitHittable(page, [selector], { settleMs: timeout, accept: (r) => r.ok && !r.disabled });
    if (!res.ok || res.disabled) {
      const why = hitMessage(selector, res.ok ? { reason: 'disabled' } : res);
      const waited = res.reason === 'bad-selector' ? '' : ` — waited ${timeout} ms`;
      throw new HitError(`${why}${waited}${times > 1 ? ` (click ${n} of ${times})` : ''}`);
    }
    if (touch) await page.touchscreen.tap(res.ix, res.iy);
    else await page.mouse.click(res.ix, res.iy);
    last = { x: res.ix, y: res.iy, input: touch ? 'touch' : 'mouse' };
  }
  return last;
}

/** Normalize hittable config from a selector array or object. Validate early:
 * a bad viewport should not fail halfway through a run, and an empty list
 * should not silently disable the protection. */
export function normalizeHittable(raw) {
  if (raw == null || raw === false) return null;
  const obj = Array.isArray(raw) ? { selectors: raw } : raw;
  if (typeof obj !== 'object') throw new Error('hittable: expected an array of selectors or { selectors, viewports, setup, settleMs }');
  const selectors = obj.selectors;
  if (!Array.isArray(selectors) || !selectors.length || !selectors.every((s) => typeof s === 'string' && s.trim())) {
    throw new Error('hittable.selectors: expected a nonempty array of CSS selectors');
  }
  const viewports = obj.viewports ?? DEFAULT_HIT_VIEWPORTS;
  if (!Array.isArray(viewports)) throw new Error('hittable.viewports: expected an array of viewport names');
  for (const vp of viewports) viewportPreset(vp);
  const setup = obj.setup ?? [];
  if (!Array.isArray(setup)) throw new Error('hittable.setup: expected an array of scenario steps');
  const settleMs = obj.settleMs ?? HIT_SETTLE_MS;
  if (!Number.isFinite(settleMs) || settleMs < 0) throw new Error('hittable.settleMs: expected a number of milliseconds >= 0');
  return { selectors, viewports, setup, settleMs };
}

/** Configured or default wait for elements to become uncovered. */
export function settleOf(cfg) {
  return cfg?.hittable?.settleMs ?? HIT_SETTLE_MS;
}

/** End-of-scenario selectors: a scenario can override the list or opt out. */
export function hittableFor(sc, cfg) {
  if (sc?.hittable === false) return [];
  if (Array.isArray(sc?.hittable)) return sc.hittable;
  return cfg?.hittable?.selectors || [];
}

/** Viewport sweeps boot a fresh game, apply hittable.setup and run the normal
 * checks. They verify phone reachability even if game scenarios use desktop only. */
export function sweepScenarios(cfg, explicitViewport = null) {
  const h = cfg?.hittable;
  if (!h || !h.selectors.length) return [];
  // An explicit --viewport overrides every scenario viewport; repeating the
  // same sweep three times would add no evidence.
  const vps = explicitViewport ? [explicitViewport] : h.viewports;
  return vps.map((vp) => ({
    name: `hittable@${vp}`,
    viewport: vp,
    note: `Must-remain-hittable sweep (${vp}): ${h.selectors.join(', ')}`,
    steps: h.setup,
    builtin: true,
  }));
}
