import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadAdapter } from '../src/harness.mjs';
import { probe } from '../src/probe.mjs';
import { runScenarios } from '../src/scenario.mjs';
import { simulate } from '../src/sim.mjs';
import { analyze } from '../src/analyze.mjs';
import { findChromium } from '../src/browser.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const GAME = path.join(ROOT, 'fixtures/tiny-game');
const FORGE = path.join(ROOT, 'game-forge/bin/forge.mjs');

// Без браузера сквозные тесты бессмысленны — честно пропускаем, а не «зеленим»
const hasBrowser = !!findChromium();
const opts = { skip: hasBrowser ? false : 'Chromium не установлен: npx playwright install chromium' };

let cfg;
before(async () => { cfg = await loadConfig(GAME); });

describe('probe', opts, () => {
  test('меряет работу кадра, ловит живой кадр и не выдумывает ошибок', async () => {
    const { metrics } = await probe(cfg, { seconds: 3 });
    assert.equal(metrics.errorCount, 0, 'фикстура обязана быть чистой');
    assert.equal(metrics.verdict, 'pass');

    assert.ok(metrics.frameWorkMs >= 0 && metrics.frameWorkMs < 16.7, `работа кадра ${metrics.frameWorkMs} мс`);
    assert.ok(metrics.frameWorkMs < metrics.frameIntervalMs,
      'работа обязана быть меньше каденса — иначе меряем не то');
    assert.ok(metrics.mainThreadBusy >= 0 && metrics.mainThreadBusy <= 1);

    const alive = metrics.checks.find((c) => c.name === 'frame-alive');
    assert.equal(alive.status, 'pass');
    assert.ok(metrics.canvas.distinctColors > 2, 'на кадре должно быть что-то нарисовано');
  });

  test('бюджет проверяется: заниженный лимит веса роняет вердикт', async () => {
    const strict = { ...cfg, budgets: { ...cfg.budgets, bundleKb: 0 } };
    const { metrics } = await probe(strict, { seconds: 2 });
    assert.equal(metrics.verdict, 'fail');
    assert.equal(metrics.checks.find((c) => c.name === 'bundle').status, 'fail');
  });
});

describe('probe --scenario', opts, () => {
  test('доводит игру до нужной сцены перед замером', async () => {
    // Без этого 20 секунд замера могли пройти в стартовой комнате, и
    // требование «мерить пиковую сцену» оставалось на совести человека
    const plain = await probe(cfg, { seconds: 2 });
    const late = await probe(cfg, { seconds: 2, scenario: 'late-game' });
    assert.equal(late.metrics.scenario, 'late-game');
    assert.equal(plain.metrics.scenario, null);
    assert.ok(late.metrics.state.level > plain.metrics.state.level,
      `сцена должна быть дальше: ${late.metrics.state.level} vs ${plain.metrics.state.level}`);
  });

  test('несуществующая сцена — понятная ошибка со списком доступных', async () => {
    await assert.rejects(() => probe(cfg, { seconds: 1, scenario: 'нет-такой' }), /Есть: smoke, late-game/);
  });
});

describe('бюджет draw calls на живой странице', opts, () => {
  test('редкий тяжёлый кадр валит бюджет, хотя среднее в норме', async () => {
    const spikeCfg = await loadConfig(path.join(ROOT, 'fixtures/spike-frame'));
    const { metrics } = await probe(spikeCfg, { seconds: 4 });
    assert.ok(metrics.drawCallsMedian <= 10, `медиана ${metrics.drawCallsMedian} — обычные кадры дешёвые`);
    assert.ok(metrics.drawCallsMax >= 600, `пик ${metrics.drawCallsMax}`);
    assert.equal(metrics.checks.find((c) => c.name === 'draw-calls').status, 'fail');
  });
});

describe('сценарии', opts, () => {
  test('play проходит и снимает кадры', async () => {
    const { summary, dir } = await runScenarios(cfg, { kind: 'play' });
    assert.equal(summary.status, 'pass');
    const sc = summary.scenarios[0];
    assert.equal(sc.checks.filter((c) => c.status !== 'pass').length, 0);
    assert.equal(sc.shots.length, 2);
    for (const s of sc.shots) {
      assert.ok(fs.existsSync(s.file), `кадр ${s.label} должен существовать`);
      assert.ok(fs.statSync(s.file).size > 500, 'PNG не должен быть пустым');
    }
    assert.ok(fs.existsSync(path.join(dir, 'play.json')));
  });

  test('провалившийся expect делает статус красным', async () => {
    // Сценарий с заведомо ложным условием: если такой прогон «зелёный»,
    // ассерты бесполезны и play перестаёт быть гейтом
    const file = path.join(GAME, 'forge', 'scenarios.broken.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'broken', viewport: 'desktop', selector: '#game',
      steps: [
        { forge: ['start'], tick: 60 },
        { expect: { fn: () => window.__FORGE__.state().score > 1e9, msg: 'заведомо ложное условие' } },
      ],
    }];`);
    try {
      const { summary } = await runScenarios({ ...cfg, scenariosFile: file }, { kind: 'play' });
      assert.equal(summary.status, 'fail');
      const failed = summary.scenarios[0].checks.filter((c) => c.status === 'fail');
      assert.equal(failed.length, 1);
      assert.match(failed[0].name, /ложное условие/);
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('симуляция', opts, () => {
  test('детерминизм: один seed — один результат', async () => {
    const a = await simulate(cfg, { runs: 3, maxTicks: 5000, seed0: 777, bots: ['veteran'] });
    const b = await simulate(cfg, { runs: 3, maxTicks: 5000, seed0: 777, bots: ['veteran'] });
    const strip = (rs) => rs.map((r) => ({ ticks: r.ticks, score: r.final.score, level: r.final.level }));
    assert.deepEqual(strip(a.runs), strip(b.runs), 'без детерминизма «фикс баланса» неверифицируем');
  });

  test('разные seed дают разные прогоны', async () => {
    const a = await simulate(cfg, { runs: 4, maxTicks: 5000, seed0: 1, bots: ['casual'] });
    const b = await simulate(cfg, { runs: 4, maxTicks: 5000, seed0: 500, bots: ['casual'] });
    const t = (r) => r.runs.map((x) => x.ticks).join(',');
    assert.notEqual(t(a), t(b), 'иначе seed ни на что не влияет');
  });

  test('навык влияет: ветеран обыгрывает казуала', async () => {
    const { dir } = await simulate(cfg, { runs: 10, maxTicks: 20000, seed0: 42 });
    const a = analyze(dir);
    const win = (n) => a.bots.find((b) => b.bot === n).winrate;
    assert.ok(win('veteran') >= win('casual'), `veteran ${win('veteran')} vs casual ${win('casual')}`);
    assert.ok(!a.flags.some((f) => f.kind === 'bot-suspect'));
  });

  test('симуляция быстрее реального времени на порядки', async () => {
    const { meta } = await simulate(cfg, { runs: 6, maxTicks: 20000, bots: ['veteran'] });
    assert.ok(meta.ticksPerSecond > 10000, `${meta.ticksPerSecond} тиков/с — слишком медленно, рендер не отключён?`);
  });

  test('кривая сложности строится по событиям адаптера', async () => {
    const { dir } = await simulate(cfg, { runs: 8, maxTicks: 20000, seed0: 7 });
    const a = analyze(dir);
    assert.ok(a.levels.length >= 3, 'фикстура проходит несколько уровней');
    for (const L of a.levels) {
      assert.ok(L.attempts >= L.clears, 'попыток не может быть меньше прохождений');
      assert.ok(L.clearRate === null || (L.clearRate >= 0 && L.clearRate <= 1));
    }
  });
});

describe('CLI', opts, () => {
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync('node', [FORGE, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };

  test('all на здоровой игре завершается нулём', () => {
    const r = run(['all', GAME, '--runs', '4', '--max-ticks', '20000']);
    assert.equal(r.code, 0, r.out.slice(-600));
    assert.match(r.out, /прогон пройден/);
  });

  test('all возвращает ненулевой код, когда probe красный', () => {
    // Тот самый случай: отчёт «Требует правок», а CI видел успех
    const tmpCfg = path.join(GAME, 'forge.config.mjs');
    const original = fs.readFileSync(tmpCfg, 'utf8');
    fs.writeFileSync(tmpCfg, original.replace('bundleKb: 64', 'bundleKb: 1'));
    try {
      const r = run(['all', GAME, '--runs', '4', '--max-ticks', '20000']);
      assert.notEqual(r.code, 0, 'красный прогон обязан валить CI');
      assert.match(r.out, /прогон не пройден/);
    } finally {
      fs.writeFileSync(tmpCfg, original);
    }
  });

  test('отключённая стадия не подтягивает старый красный прогон', () => {
    // Сценарий из ревью: вчерашний sim был красным, сегодня адаптер отключён.
    // Раньше `??` подставлял старый analysis — отчёт краснел, а код выхода
    // считался по текущему (пустому) результату и оставался нулевым.
    const cfgFile = path.join(GAME, 'forge.config.mjs');
    const original = fs.readFileSync(cfgFile, 'utf8');
    const simDir = path.join(GAME, '.forge', 'latest-sim');

    // гарантируем наличие «вчерашнего» красного анализа
    execFileSync('node', [FORGE, 'sim', GAME, '--runs', '4', '--max-ticks', '5000'], { encoding: 'utf8' });
    const analysisFile = path.join(fs.realpathSync(simDir), 'analysis.json');
    const analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    analysis.verdict = 'needs-work';
    analysis.flags = [{ kind: 'wall', level: 1, severity: 'high', detail: 'вчерашняя стена' }];
    fs.writeFileSync(analysisFile, JSON.stringify(analysis));

    // отключаем и адаптер, и сценарии: сценарии фикстуры сами требуют адаптер,
    // и без него упали бы, замаскировав проверяемое поведение
    fs.writeFileSync(cfgFile, original.replace(/\s*(adapter|scenarios): .*,\n/g, '\n'));
    try {
      const r = run(['all', GAME]);
      assert.equal(r.code, 0, 'текущий прогон чистый — код обязан быть нулевым');
      const reportFile = path.join(fs.realpathSync(path.join(GAME, '.forge', 'latest-report')), 'index.html');
      const html = fs.readFileSync(reportFile, 'utf8');
      assert.doesNotMatch(html, /вчерашняя стена/, 'старый прогон не должен попадать в свежий отчёт');
      assert.doesNotMatch(html, /Требует правок/);
    } finally {
      fs.writeFileSync(cfgFile, original);
    }
  });

  test('doctor печатает окружение', () => {
    const r = run(['doctor']);
    assert.match(r.out, /Chromium/);
    assert.match(r.out, /Node/);
  });

  test('неизвестная игра — понятная ошибка, а не стектрейс', () => {
    const r = run(['probe', '/tmp/нет-такой-игры-forge']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /forge\.config\.mjs/);
  });
});

describe('адаптер фикстуры', opts, () => {
  test('соответствует контракту ADAPTER.md', async () => {
    const adapter = await loadAdapter(cfg);
    assert.equal(typeof adapter.install, 'function');
    assert.equal(adapter.tickRate, 60);
    // install сериализуется в браузер — замыкания на модульные переменные
    // не переживут переезд, поэтому в теле не должно быть импортов
    const src = adapter.install.toString();
    assert.doesNotMatch(src, /\bimport\b|\brequire\(/);
  });
});
