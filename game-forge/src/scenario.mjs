import path from 'node:path';
import { boot, loadAdapter, loadScenarios } from './harness.mjs';
import { resolveViewport } from './browser.mjs';
import { realClick, hittableChecks, hittableFor, sweepScenarios, settleOf, HitError, WAIT_VISIBLE_MS } from './hittest.mjs';
import { runDir, linkLatest, writeJson, filterNoise, color, verdictMark } from './util.mjs';

/** Shared engine for `shots` (capture frames) and `play` (run assertions).
 * They differ only in whether a failed expect makes the command fail.
 * Step keys execute in this order: goto, forge, eval, click, realClick, move,
 * key, type, tick, wait, waitFor, hittable, expect, shot.
 * At scenario end, check config/scenario hittable selectors and add
 * hittable@<viewport> sweeps; see hittest.mjs. */
export async function runScenarios(cfg, opts = {}) {
  const { only = null, seed = 1, stamp, kind = 'shots', headless = true, viewport = null } = opts;
  const adapter = cfg.adapterFile ? await loadAdapter(cfg) : null;
  // Viewport sweeps are ordinary scenarios: --only selects them and reports include them.
  const all = [...await loadScenarios(cfg), ...sweepScenarios(cfg, viewport)];
  const list = only ? all.filter((s) => s.name === only) : all;
  if (!list.length) {
    throw new Error(only
      ? `Scenario "${only}" not found. Available: ${all.map((s) => s.name).join(', ') || '(none)'}`
      : `No scenarios configured. Set scenarios in forge.config.mjs`);
  }

  const dir = runDir(cfg.dir, kind, stamp);
  const shotsDir = path.join(dir, 'shots');
  const results = [];

  for (const sc of list) {
    // Match probe precedence: explicit flag, scenario viewport, config.
    // Otherwise forge all --viewport phone mixes phone metrics with desktop shots.
    const vp = resolveViewport(viewport, sc, cfg);
    const ctx = await boot(cfg, { viewport: vp, seed, adapter, headless });
    const shots = [];
    const checks = [];
    let at = 0;
    try {
      for (const [i, step] of (sc.steps || []).entries()) {
        at = i;
        await applyStep(ctx.page, step, { sc, i, shotsDir, shots, checks, cfg });
      }
      // Only check scenarios that reached the end. An overlay halfway through a
      // failed action does not prove that the final interface is blocked.
      const sels = hittableFor(sc, cfg);
      if (sels.length) {
        // keepOnFail: the scenario has ended, so the failure screenshot should show
        // the overlay at the coordinates reported in the message.
        const hit = await hittableChecks(ctx.page, sels, settleOf(cfg), { keepOnFail: true });
        checks.push(...hit);
        const failed = hit.find((c) => c.status === 'fail');
        if (failed) await failShot(ctx.page, sc, shotsDir, shots, failed.detail);
      }
    } catch (err) {
      // Report the step index, not the count of checks, to identify the actual failed step.
      const msg = err instanceof HitError ? err.message : String(err);
      checks.push({ name: `step ${at + 1}`, status: 'fail', detail: msg.slice(0, 400) });
      if (err instanceof HitError) await failShot(ctx.page, sc, shotsDir, shots, msg);
    } finally {
      const errors = filterNoise(ctx.errors());
      results.push({
        scenario: sc.name,
        viewport: vp,
        note: sc.note || null,
        shots,
        checks,
        errors,
        status: checks.some((c) => c.status === 'fail') || errors.length ? 'fail'
          : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass',
      });
      await ctx.dispose();
    }
  }

  const summary = {
    game: cfg.name,
    kind,
    seed,
    scenarios: results,
    status: results.some((r) => r.status === 'fail') ? 'fail' : 'pass',
    // Explicit review pointers: what to inspect and what to compare against.
    critique: {
      shotsDir,
      referencesDir: cfg.referencesDir,
      hint: 'Compare each screenshot against referencesDir and the scenario note.',
    },
  };
  writeJson(path.join(dir, `${kind}.json`), summary);
  linkLatest(cfg.dir, kind, dir);
  return { summary, dir };
}

/** Run one scenario step. Exported so probe prepares the same scene through
 * the same mechanism instead of implementing a second version. */
export async function applyStep(page, step, ctx) {
  const { sc, i, shotsDir, shots, checks } = ctx;

  if (step.goto) await page.goto(step.goto, { waitUntil: 'load' });

  if (step.forge) {
    const [method, ...args] = Array.isArray(step.forge) ? step.forge : [step.forge];
    await page.evaluate(({ m, a }) => {
      const api = window.__FORGE__;
      if (!api || typeof api[m] !== 'function') throw new Error(`__FORGE__.${m}() is missing; check the adapter`);
      return api[m](...a);
    }, { m: method, a: args });
  }

  if (step.eval) await page.evaluate(step.eval, step.arg ?? null);

  if (step.click) {
    const box = await gameBox(page);
    if (step.click === 'center') await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // Selector clicks use real input only when the element is on top. Playwright
    // page.click also checks overlays, but waits 30 seconds without identifying
    // the blocking layer and does not provide touch input.
    else if (typeof step.click === 'string') await realClick(page, step.click, clickOpts(step));
    else await page.mouse.click(box.x + step.click.x, box.y + step.click.y);
  }

  // Use player input instead of el.click(): DOM clicks bypass overlays and can
  // pass a scenario even when no button is physically clickable.
  if (step.realClick) await realClick(page, step.realClick, clickOpts(step));

  if (step.move) {
    const box = await gameBox(page);
    await page.mouse.move(box.x + step.move.x, box.y + step.move.y);
  }

  if (step.key) await page.keyboard.press(step.key);
  if (step.type) await page.keyboard.type(step.type);

  // Advance logic without wall-clock time: 600 ticks cover 10 game seconds in ~50 ms.
  // With bot, the policy drives; otherwise the gameplay screenshot may show
  // a game where nobody plays and the player loses after ten seconds.
  if (step.tick) {
    await page.evaluate(({ n, bot }) => {
      const api = window.__FORGE__;
      if (!api?.tick) throw new Error('__FORGE__.tick() is missing; a tick step requires an adapter');
      if (bot) {
        const policy = api.bots?.[bot];
        if (!policy) throw new Error(`Bot "${bot}" is not defined by the adapter`);
        const memory = {};
        let lastAction = null, lastOk = null;
        for (let i = 0; i < n; i++) {
          const st = api.state();
          if (st.over) break;
          const input = policy(st, { memory, tick: i, seed: 1, lastAction, lastOk });
          if (input != null) { lastOk = api.act(input) !== false; lastAction = input; }
          api.tick(1);
        }
      } else {
        api.tick(n);
      }
      api.render?.();
    }, { n: step.tick, bot: step.bot || null });
  }

  if (step.wait) await page.waitForTimeout(step.wait);
  if (step.waitFor) await page.waitForFunction(step.waitFor, null, { timeout: step.timeout || 10000 });

  // Check without clicking: record failure like expect and continue the scenario.
  // Scroll to the element if necessary, as a player would.
  if (step.hittable) {
    const sels = Array.isArray(step.hittable) ? step.hittable : [step.hittable];
    // Restore scrolling even on failure so later play steps use the same page
    // position as probe.
    const hit = await hittableChecks(page, sels, step.timeout ?? settleOf(ctx.cfg));
    checks.push(...hit);
    const failed = hit.find((c) => c.status === 'fail');
    if (failed && !ctx.skipShots) await failShot(page, sc, shotsDir, shots, failed.detail, i);
  }

  if (step.expect) {
    const ok = await page.evaluate(step.expect.fn ?? step.expect);
    const msg = step.expect.msg || 'expect';
    // Require strict true. A natural enemies-spawned assertion may return
    // [...document.querySelectorAll(".enemy")]; an empty array is truthy and
    // would incorrectly pass on an empty scene.
    const detail = ok === true ? ''
      : typeof ok === 'boolean' ? `condition is false at step ${i + 1}`
        : `step ${i + 1}: expect returned ${preview(ok)} instead of true/false; invalid assertion`;
    checks.push({ name: msg, status: ok === true ? 'pass' : 'fail', detail });
  }

  if (step.shot && !ctx.skipShots) {
    const file = path.join(shotsDir, `${sc.name}-${step.shot}.png`);
    const target = step.full ? page : (await page.$(sc.selector || 'canvas')) || page;
    await target.screenshot({ path: file });
    shots.push({ file, label: step.shot, note: step.note || null, step: i + 1 });
  }
}

function clickOpts(step) {
  return { timeout: step.timeout || WAIT_VISIBLE_MS, times: step.times || 1 };
}

/** Capture the full page on failure: overlays involve layout around the canvas,
 * so the reviewer needs to see which layer covers it. */
async function failShot(page, sc, shotsDir, shots, note, i = null) {
  if (!shotsDir) return;
  const label = i == null ? 'hittable' : `hittable-${i + 1}`;
  const file = path.join(shotsDir, `${sc.name}-${label}.png`);
  // The original failure is already recorded; a screenshot error must not replace it.
  try {
    await page.screenshot({ path: file });
    shots.push({ file, label, note: `Hit-test failure: ${note}`, step: i == null ? null : i + 1 });
  } catch { /* Screenshot unavailable. */ }
}

/** Short human-readable value for an invalid assertion result. */
function preview(v) {
  if (v === null || v === undefined) return String(v);
  try {
    const s = JSON.stringify(v);
    return s === undefined ? typeof v : s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return typeof v;
  }
}

async function gameBox(page) {
  const el = await page.$('canvas');
  if (el) { const b = await el.boundingBox(); if (b) return b; }
  const vp = page.viewportSize();
  return { x: 0, y: 0, width: vp.width, height: vp.height };
}

export function printScenarios(summary) {
  console.log(color.b(`\n${summary.game} — ${summary.kind}`));
  for (const r of summary.scenarios) {
    console.log(`  ${verdictMark(r.status)} ${r.scenario} ${color.dim(`(${r.viewport}, shots: ${r.shots.length})`)}`);
    for (const c of r.checks) if (c.status !== 'pass') console.log(`      ${verdictMark(c.status)} ${c.name} — ${c.detail}`);
    for (const e of r.errors.slice(0, 3)) console.log(`      ${color.bad('err')} ${e.kind}: ${e.text.slice(0, 160)}`);
  }
  console.log(color.dim(`  screenshots: ${summary.critique.shotsDir}`));
}
