import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { combineVerdict, report } from '../src/report.mjs';
import { loadConfig, loadAdapter, loadScenarios } from '../src/harness.mjs';

describe('combineVerdict — худший статус побеждает', () => {
  test('красный probe перебивает зелёный баланс', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'fail' }, analysis: { verdict: 'ok' } }), 'fail');
  });

  test('провал сценариев тоже красит отчёт', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'pass' }, scenarios: { status: 'fail' } }), 'fail');
  });

  test('needs-work баланса красит отчёт при чистой технике', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'pass' }, analysis: { verdict: 'needs-work' } }), 'needs-work');
  });

  test('warn поднимается до «под наблюдением», но не до провала', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'warn' }, analysis: { verdict: 'ok' } }), 'warn');
  });

  test('всё чисто — зелёный', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'pass' }, analysis: { verdict: 'ok' }, scenarios: { status: 'pass' } }), 'pass');
  });

  test('нет данных — не выдумываем провал', () => {
    assert.equal(combineVerdict({}), 'ok');
  });
});

describe('report', () => {
  const cfg = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-report-'));
    return { name: 'Тестовая игра', dir, referencesDir: path.join(dir, 'refs') };
  };

  test('HTML самодостаточен: ни одной внешней загрузки', () => {
    const file = report(cfg(), {
      probe: { verdict: 'pass', frameWorkMs: 1, frameWorkP99Ms: 2, frameWorkMaxMs: 3, mainThreadBusy: 0.1, headroom: 16, errorCount: 0, bundleKb: 10, loadMs: 100, drawCallsPerFrame: 0, checks: [], errors: [] },
    });
    const html = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(html, /<script src=|<link[^>]+href="http/i, 'отчёт должен открываться офлайн');
    assert.match(html, /Тестовая игра/);
  });

  test('красный probe виден в шапке отчёта', () => {
    const file = report(cfg(), {
      probe: { verdict: 'fail', frameWorkMs: 99, frameWorkP99Ms: 200, frameWorkMaxMs: 300, mainThreadBusy: 0.9, headroom: 0.2, errorCount: 3, bundleKb: 9999, loadMs: 9000, drawCallsPerFrame: 50, checks: [{ name: 'frame-work', status: 'fail', detail: 'медленно' }], errors: [] },
      analysis: { verdict: 'ok', bots: [], levels: [], flags: [], progress: [] },
    });
    assert.match(fs.readFileSync(file, 'utf8'), /Требует правок/);
  });

  test('экранирование: имя игры не может внедрить разметку', () => {
    const c = cfg();
    c.name = '<img src=x onerror=alert(1)>';
    const html = fs.readFileSync(report(c, {}), 'utf8');
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
});

describe('loadConfig / loadAdapter', () => {
  const write = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cfg-'));
    for (const [name, body] of Object.entries(files)) {
      const f = path.join(dir, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
    return dir;
  };

  test('умолчания подставляются, свои значения побеждают', async () => {
    const dir = write({ 'forge.config.mjs': 'export default { name: "X", budgets: { errors: 5 } }' });
    const cfg = await loadConfig(dir);
    assert.equal(cfg.name, 'X');
    assert.equal(cfg.entry, 'index.html');
    assert.equal(cfg.renderer, '2d');
    assert.equal(cfg.budgets.errors, 5, 'своё значение');
    assert.equal(cfg.budgets.frameMs, 16.7, 'остальные бюджеты из умолчаний');
  });

  test('без конфига — понятная ошибка с подсказкой', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-empty-'));
    await assert.rejects(() => loadConfig(empty), /forge\.config\.mjs/);
  });

  test('адаптер не объявлен — это не ошибка', async () => {
    const dir = write({ 'forge.config.mjs': 'export default { name: "X" }' });
    assert.equal(await loadAdapter(await loadConfig(dir)), null);
  });

  test('адаптер объявлен, но отсутствует — падаем', async () => {
    const dir = write({ 'forge.config.mjs': 'export default { name: "X", adapter: "./forge/adapter.mjs" }' });
    const cfg = await loadConfig(dir);
    await assert.rejects(() => loadAdapter(cfg), /Адаптер не найден/);
  });

  test('адаптер без install() — падаем, а не притворяемся, что его нет', async () => {
    const dir = write({
      'forge.config.mjs': 'export default { name: "X", adapter: "./forge/adapter.mjs" }',
      'forge/adapter.mjs': 'export default { autostart: true }',
    });
    const cfg = await loadConfig(dir);
    await assert.rejects(() => loadAdapter(cfg), /install\(\)/);
  });

  test('сломанный адаптер бросает синтаксическую ошибку', async () => {
    const dir = write({
      'forge.config.mjs': 'export default { name: "X", adapter: "./forge/adapter.mjs" }',
      'forge/adapter.mjs': 'export default { install() { это не JS } }',
    });
    const cfg = await loadConfig(dir);
    await assert.rejects(() => loadAdapter(cfg));
  });

  test('сценарии без файла — пустой список', async () => {
    const dir = write({ 'forge.config.mjs': 'export default { name: "X" }' });
    const cfg = await loadConfig(dir);
    assert.deepEqual(await loadScenarios(cfg), []);
  });
});
