import path from 'node:path';
import { boot, loadAdapter, loadScenarios } from './harness.mjs';
import { runDir, linkLatest, writeJson, filterNoise, color, verdictMark } from './util.mjs';

/**
 * Один движок для двух команд: `shots` (снять кадры для арт-критика) и
 * `play` (пройти сценарий и проверить ассерты). Разница только в том,
 * падаем ли мы на непройденном expect.
 *
 * Шаг — объект с любым набором ключей, они применяются в этом порядке:
 *   goto, forge, eval, click, move, key, type, tick, wait, expect, shot
 */
export async function runScenarios(cfg, opts = {}) {
  const { only = null, seed = 1, stamp, kind = 'shots', headless = true } = opts;
  const adapter = cfg.adapterFile ? await loadAdapter(cfg) : null;
  const all = await loadScenarios(cfg);
  const list = only ? all.filter((s) => s.name === only) : all;
  if (!list.length) {
    throw new Error(only
      ? `Сценарий "${only}" не найден. Есть: ${all.map((s) => s.name).join(', ') || '(ни одного)'}`
      : `Сценарии не заданы. Добавь scenarios в forge.config.mjs`);
  }

  const dir = runDir(cfg.dir, kind, stamp);
  const shotsDir = path.join(dir, 'shots');
  const results = [];

  for (const sc of list) {
    const ctx = await boot(cfg, { viewport: sc.viewport || cfg.viewport, seed, adapter, headless });
    const shots = [];
    const checks = [];
    try {
      for (const [i, step] of (sc.steps || []).entries()) {
        await applyStep(ctx.page, step, { sc, i, shotsDir, shots, checks, cfg });
      }
    } catch (err) {
      checks.push({ name: `шаг ${checks.length + 1}`, status: 'fail', detail: String(err).slice(0, 300) });
    } finally {
      const errors = filterNoise(ctx.errors());
      results.push({
        scenario: sc.name,
        viewport: sc.viewport || cfg.viewport,
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
    // Явный указатель для агента-критика: что смотреть и с чем сравнивать.
    critique: {
      shotsDir,
      referencesDir: cfg.referencesDir,
      hint: 'Сравни каждый кадр с эталонами из referencesDir и с note сценария.',
    },
  };
  writeJson(path.join(dir, `${kind}.json`), summary);
  linkLatest(cfg.dir, kind, dir);
  return { summary, dir };
}

/**
 * Выполнить один шаг сценария. Экспортируется, чтобы probe мог довести игру
 * до нужной сцены тем же механизмом, а не заводить второй похожий.
 */
export async function applyStep(page, step, ctx) {
  const { sc, i, shotsDir, shots, checks } = ctx;

  if (step.goto) await page.goto(step.goto, { waitUntil: 'load' });

  if (step.forge) {
    const [method, ...args] = Array.isArray(step.forge) ? step.forge : [step.forge];
    await page.evaluate(({ m, a }) => {
      const api = window.__FORGE__;
      if (!api || typeof api[m] !== 'function') throw new Error(`__FORGE__.${m}() нет — проверь адаптер`);
      return api[m](...a);
    }, { m: method, a: args });
  }

  if (step.eval) await page.evaluate(step.eval, step.arg ?? null);

  if (step.click) {
    const box = await gameBox(page);
    if (step.click === 'center') await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    else if (typeof step.click === 'string') await page.click(step.click);
    else await page.mouse.click(box.x + step.click.x, box.y + step.click.y);
  }

  if (step.move) {
    const box = await gameBox(page);
    await page.mouse.move(box.x + step.move.x, box.y + step.move.y);
  }

  if (step.key) await page.keyboard.press(step.key);
  if (step.type) await page.keyboard.type(step.type);

  // Логические кадры без реального времени: 600 «тиков» — это 10 секунд игры за ~50 мс.
  // С `bot` за руль садится политика — иначе кадр «геймплея» покажет игру,
  // в которой никто не играет, то есть проигрыш через десять секунд.
  if (step.tick) {
    await page.evaluate(({ n, bot }) => {
      const api = window.__FORGE__;
      if (!api?.tick) throw new Error('__FORGE__.tick() нет — шаг tick требует адаптер');
      if (bot) {
        const policy = api.bots?.[bot];
        if (!policy) throw new Error(`Бот "${bot}" не объявлен адаптером`);
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

  if (step.expect) {
    const ok = await page.evaluate(step.expect.fn ?? step.expect);
    const msg = step.expect.msg || 'expect';
    checks.push({ name: msg, status: ok ? 'pass' : 'fail', detail: ok ? '' : `условие ложно на шаге ${i + 1}` });
  }

  if (step.shot && !ctx.skipShots) {
    const file = path.join(shotsDir, `${sc.name}-${step.shot}.png`);
    const target = step.full ? page : (await page.$(sc.selector || 'canvas')) || page;
    await target.screenshot({ path: file });
    shots.push({ file, label: step.shot, note: step.note || null, step: i + 1 });
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
    console.log(`  ${verdictMark(r.status)} ${r.scenario} ${color.dim(`(${r.viewport}, кадров: ${r.shots.length})`)}`);
    for (const c of r.checks) if (c.status !== 'pass') console.log(`      ${verdictMark(c.status)} ${c.name} — ${c.detail}`);
    for (const e of r.errors.slice(0, 3)) console.log(`      ${color.bad('err')} ${e.kind}: ${e.text.slice(0, 160)}`);
  }
  console.log(color.dim(`  кадры: ${summary.critique.shotsDir}`));
}
