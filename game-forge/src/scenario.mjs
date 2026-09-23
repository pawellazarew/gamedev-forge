import path from 'node:path';
import { boot, loadAdapter, loadScenarios } from './harness.mjs';
import { resolveViewport } from './browser.mjs';
import { realClick, hittableChecks, hittableFor, sweepScenarios, settleOf, HitError, WAIT_VISIBLE_MS } from './hittest.mjs';
import { runDir, linkLatest, writeJson, filterNoise, color, verdictMark } from './util.mjs';

/**
 * Один движок для двух команд: `shots` (снять кадры для арт-критика) и
 * `play` (пройти сценарий и проверить ассерты). Разница только в том,
 * падаем ли мы на непройденном expect.
 *
 * Шаг — объект с любым набором ключей, они применяются в этом порядке:
 *   goto, forge, eval, click, realClick, move, key, type, tick, wait, waitFor,
 *   hittable, expect, shot
 *
 * В конце каждого сценария селекторы из `hittable` конфига (или сценария)
 * проверяются на кликабельность, а к сценариям добавляется обход
 * `hittable@<вьюпорт>` — см. hittest.mjs.
 */
export async function runScenarios(cfg, opts = {}) {
  const { only = null, seed = 1, stamp, kind = 'shots', headless = true, viewport = null } = opts;
  const adapter = cfg.adapterFile ? await loadAdapter(cfg) : null;
  // Обход по вьюпортам — обычные сценарии: их так же выбирает --only и так же
  // видит отчёт.
  const all = [...await loadScenarios(cfg), ...sweepScenarios(cfg, viewport)];
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
    // Тот же порядок, что у probe: явный флаг → вьюпорт сценария → конфиг.
    // Иначе `forge all --viewport phone` кладёт в один отчёт телефонные числа
    // и десктопные кадры, и арт-критик судит не ту сцену.
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
      // Проверяем только дошедший до конца сценарий: после упавшего шага
      // игра стоит посреди действия, и перекрытие там ничего не доказывает.
      const sels = hittableFor(sc, cfg);
      if (sels.length) {
        const hit = await hittableChecks(ctx.page, sels, settleOf(cfg));
        checks.push(...hit);
        const failed = hit.find((c) => c.status === 'fail');
        if (failed) await failShot(ctx.page, sc, shotsDir, shots, failed.detail);
      }
    } catch (err) {
      // Номер шага, а не число проверок: «шаг 3» на седьмом шаге отправлял искать не там
      const msg = err instanceof HitError ? err.message : String(err);
      checks.push({ name: `шаг ${at + 1}`, status: 'fail', detail: msg.slice(0, 400) });
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
    // Клик по селектору — только настоящим вводом и только если сверху лежит
    // сам элемент. page.click Playwright тоже проверял перекрытие, но молча
    // ждал полминуты, не умел касание и не говорил, какой слой мешает.
    else if (typeof step.click === 'string') await realClick(page, step.click, clickOpts(step));
    else await page.mouse.click(box.x + step.click.x, box.y + step.click.y);
  }

  // Клик игрока, а не `el.click()`: DOM-клик проходит сквозь любой слой сверху,
  // и сценарий зеленел на игре, где не нажимается ни одна кнопка.
  if (step.realClick) await realClick(page, step.realClick, clickOpts(step));

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

  // Проверка без клика: провал записывается, как у expect, и сценарий идёт дальше.
  // При необходимости докручивает к элементу — как сделал бы игрок.
  if (step.hittable) {
    const sels = Array.isArray(step.hittable) ? step.hittable : [step.hittable];
    const hit = await hittableChecks(page, sels, step.timeout ?? settleOf(ctx.cfg));
    checks.push(...hit);
    const failed = hit.find((c) => c.status === 'fail');
    if (failed && !ctx.skipShots) await failShot(page, sc, shotsDir, shots, failed.detail, i);
  }

  if (step.expect) {
    const ok = await page.evaluate(step.expect.fn ?? step.expect);
    const msg = step.expect.msg || 'expect';
    // Строго true, а не «истинно»: естественная форма ассерта «враги
    // заспавнены» — это `[...document.querySelectorAll('.enemy')]`, и пустой
    // массив истинен. Такой expect проходил бы ровно на пустой сцене.
    const detail = ok === true ? ''
      : typeof ok === 'boolean' ? `условие ложно на шаге ${i + 1}`
        : `шаг ${i + 1}: expect вернул ${preview(ok)} вместо true/false — ассерт написан неверно`;
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

/**
 * Кадр страницы целиком в момент провала: перекрытие — это про вёрстку
 * вокруг канваса, и критику нужно видеть, что именно легло сверху.
 */
async function failShot(page, sc, shotsDir, shots, note, i = null) {
  if (!shotsDir) return;
  const label = i == null ? 'hittable' : `hittable-${i + 1}`;
  const file = path.join(shotsDir, `${sc.name}-${label}.png`);
  // Не снялось — провал уже записан, подменять его ошибкой скриншота нельзя
  try {
    await page.screenshot({ path: file });
    shots.push({ file, label, note: `Провал кликабельности: ${note}`, step: i == null ? null : i + 1 });
  } catch { /* кадра не будет */ }
}

/** Короткое человекочитаемое значение для сообщения о неверном ассерте. */
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
    console.log(`  ${verdictMark(r.status)} ${r.scenario} ${color.dim(`(${r.viewport}, кадров: ${r.shots.length})`)}`);
    for (const c of r.checks) if (c.status !== 'pass') console.log(`      ${verdictMark(c.status)} ${c.name} — ${c.detail}`);
    for (const e of r.errors.slice(0, 3)) console.log(`      ${color.bad('err')} ${e.kind}: ${e.text.slice(0, 160)}`);
  }
  console.log(color.dim(`  кадры: ${summary.critique.shotsDir}`));
}
