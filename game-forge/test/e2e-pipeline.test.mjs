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

  test('вьюпорт берётся из сценария, явный флаг его перебивает', async () => {
    // Сцена «phone» на 1280 пикселях — это замер другой сцены: раскладка,
    // масштаб и число объектов на экране другие.
    const file = path.join(GAME, 'forge', 'scenarios.phone.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'phone-peak', viewport: 'phone', selector: '#game',
      steps: [{ forge: ['start'], tick: 120 }],
    }];`);
    try {
      const scoped = { ...cfg, scenariosFile: file };
      const auto = await probe(scoped, { seconds: 1, scenario: 'phone-peak' });
      assert.equal(auto.metrics.viewport, 'phone', 'вьюпорт сценария важнее вьюпорта конфига');

      const forced = await probe(scoped, { seconds: 1, scenario: 'phone-peak', viewport: 'desktop' });
      assert.equal(forced.metrics.viewport, 'desktop', 'явный --viewport важнее сценария');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('ложный expect в подготовке сцены отменяет замер', async () => {
    // Раньше проваленный expect терялся вместе с одноразовым массивом checks,
    // и probe спокойно мерил сцену, которая не собралась.
    const file = path.join(GAME, 'forge', 'scenarios.badprep.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'badprep', viewport: 'desktop', selector: '#game',
      steps: [
        { forge: ['start'], tick: 60 },
        { expect: { fn: () => window.__FORGE__.state().score > 1e9, msg: 'сцена доведена до пика' } },
      ],
    }];`);
    try {
      await assert.rejects(
        () => probe({ ...cfg, scenariosFile: file }, { seconds: 2, scenario: 'badprep' }),
        /не подготовлена.*сцена доведена до пика/s,
      );
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('достоверность замера на живой странице', opts, () => {
  test('нулевая длительность отвергается до запуска браузера', async () => {
    await assert.rejects(() => probe(cfg, { seconds: 0 }), /положительным числом/);
  });

  test('игра с мёртвым циклом рендера не проходит, хотя кадр выглядит живым', async () => {
    // Фикстура рисует один раз и больше не перерисовывается. Проба крутит свой
    // rAF и насчитывает ей десятки кадров — по кадрам пробы всё «отлично».
    const deadCfg = await loadConfig(path.join(ROOT, 'fixtures/dead-game'));
    const { metrics } = await probe(deadCfg, { seconds: 2 });

    assert.ok(metrics.frames >= 20, `кадров пробы ${metrics.frames} — они идут независимо от игры`);
    assert.equal(metrics.gameFrames, 0, 'а игра не нарисовала ни одного');
    assert.equal(metrics.checks.find((c) => c.name === 'frame-alive').status, 'pass',
      'статичная картинка обманывает проверку живого кадра — ловить должна выборка');
    assert.equal(metrics.checks.find((c) => c.name === 'frame-work'), undefined,
      'чисел кадра без кадров не существует: раньше нулевая работа печаталась как PASS');
    assert.equal(metrics.checks.find((c) => c.name === 'sample').status, 'fail');
    assert.equal(metrics.verdict, 'fail');
  });

  test('пустой цикл rAF не выдаётся за живую игру', async () => {
    // Фикстура крутит `requestAnimationFrame(loop)` с пустым телом: кадры игры
    // идут полным потоком, картинка застыла. Ловит только проверка отрисовки.
    const zombieCfg = await loadConfig(path.join(ROOT, 'fixtures/zombie-game'));
    const { metrics } = await probe(zombieCfg, { seconds: 2 });

    assert.ok(metrics.gameFrames >= 20, `кадров игры ${metrics.gameFrames} — цикл жив`);
    assert.equal(metrics.paintFrames, 0,
      'по игровому канвасу — ни одной команды, хотя соседний канвас-индикатор рисуется каждый кадр');
    assert.equal(metrics.pixelChange, 0, 'и ни один пиксель игрового канваса не изменился');
    assert.equal(metrics.checks.find((c) => c.name === 'sample').status, 'pass',
      'по кадрам игры выборка полноценная — тем и опасен зомби');
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'fail');
    assert.equal(metrics.verdict, 'fail');
  });

  test('живая игра рисует и это видно', async () => {
    const { metrics } = await probe(cfg, { seconds: 2 });
    assert.ok(metrics.paintFrames >= 20, `кадров с отрисовкой ${metrics.paintFrames}`);
    assert.ok(metrics.pixelChange > 0, `пиксели канваса менялись на ${metrics.pixelChange}`);
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'pass');
  });

  test('отрисовка в закадровый буфер не ручается за застывший экран', async () => {
    // Потерянный blit: сцена честно рисуется каждый кадр — в канвас, которого
    // игрок не видит. Признак отрисовки обязан быть привязан к видимой
    // поверхности, иначе за мёртвый экран ручается закадровый помощник.
    const ghostCfg = await loadConfig(path.join(ROOT, 'fixtures/ghost-backbuffer'));
    const { metrics } = await probe(ghostCfg, { seconds: 2 });

    assert.equal(metrics.paintFrames, 0, 'закадровый канвас отрисовкой не считается');
    assert.ok(metrics.gameFrames >= 20, 'при этом цикл жив и рисует вовсю');
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'fail');
    assert.equal(metrics.verdict, 'fail');
  });

  test('настоящий on-demand без rAF не объявляется мёртвым', async () => {
    // Форма Wordle: рисует в обработчике ввода, requestAnimationFrame не
    // заводит вовсе. Кадров игры ноль по определению — и это не поломка.
    // Прошлая версия фикстуры крутила пустой rAF и прятала эту дыру.
    const dirtyCfg = await loadConfig(path.join(ROOT, 'fixtures/dirty-render'));
    const onDemand = await probe(dirtyCfg, { seconds: 2 });

    assert.equal(onDemand.metrics.renderMode, 'on-demand');
    assert.equal(onDemand.metrics.gameFrames, 0, 'rAF не вызывался ни разу');
    assert.equal(onDemand.metrics.checks.find((c) => c.name === 'sample').status, 'warn');
    assert.notEqual(onDemand.metrics.verdict, 'fail', 'здоровая пошаговая игра не должна валить CI');

    // Та же игра без объявленного режима — красная: молчать о застывшем
    // рендере нельзя, пока игра не сказала, что рисует по событию.
    const strict = await probe({ ...dirtyCfg, renderMode: 'continuous' }, { seconds: 2 });
    assert.equal(strict.metrics.checks.find((c) => c.name === 'sample').status, 'fail');
    assert.equal(strict.metrics.verdict, 'fail');
  });

  test('рендер, умерший посреди окна, валит прогон', async () => {
    // Отрисовка идёт первые полторы секунды и встаёт. Доля кадров при этом
    // высокая — ловит только хвост окна.
    const dyingCfg = await loadConfig(path.join(ROOT, 'fixtures/dying-render'));
    const { metrics } = await probe(dyingCfg, { seconds: 3 });

    assert.ok(metrics.paintFrames > 0, 'сначала игра рисовала');
    assert.ok(metrics.lastPaintAt < metrics.frames * 0.75,
      `последняя отрисовка на кадре ${metrics.lastPaintAt} из ${metrics.frames}`);
    const render = metrics.checks.find((c) => c.name === 'render');
    assert.equal(render.status, 'fail');
    assert.match(render.detail, /отрисовка встала/);
    assert.ok(metrics.paintFrames / metrics.gameFrames >= 0.5,
      `доля ${metrics.paintFrames}/${metrics.gameFrames} — фикстура обязана рисовать полноценно до смерти`);
    assert.equal(metrics.verdict, 'fail');
  });

  test('экран, доигравший анимацию и замерший, не объявляется мёртвым', async () => {
    // Титульный экран, экран паузы, победы — любой из них перестаёт рисовать
    // и ждёт ввода. Отличить это от смерти рендера без синтетического ввода
    // нечем, поэтому предупреждение, а не провал: красный тут блокирует
    // здоровую игру.
    const introCfg = await loadConfig(path.join(ROOT, 'fixtures/settling-intro'));
    const { metrics } = await probe(introCfg, { seconds: 3 });

    assert.ok(metrics.paintFrames > 0, 'заставка рисовалась');
    assert.ok(metrics.paintFrames < metrics.gameFrames, 'а потом перестала');
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'warn');
    assert.notEqual(metrics.verdict, 'fail');
  });

  test('индикатор, объявленный раньше игрового канваса, не забирает замер', async () => {
    // `document.querySelector('canvas')` брал первый в DOM — им мог оказаться
    // прелоадер, фон или полоска счёта, и здоровая игра краснела.
    const hudCfg = await loadConfig(path.join(ROOT, 'fixtures/hud-first'));
    const { metrics } = await probe(hudCfg, { seconds: 2 });

    assert.ok(metrics.paintFrames >= 20, `кадров с отрисовкой ${metrics.paintFrames}`);
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'pass');
    assert.equal(metrics.verdict, 'pass');
  });

  test('отрисовка из таймера, а не из кадра игры, за игру не считается', async () => {
    // Пустой цикл rAF плюс рисующий setInterval: пиксели меняются, команды
    // идут — но не из кадра игры, и ручаться за живой цикл они не могут.
    const outsideCfg = await loadConfig(path.join(ROOT, 'fixtures/outside-loop'));
    const { metrics } = await probe(outsideCfg, { seconds: 2 });

    assert.equal(metrics.paintFrames, 0, 'ни одной команды изнутри кадра игры');
    assert.ok(metrics.pixelChange > 0, 'при этом картинка меняется');
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'warn');
  });

  test('канвас, показанный после загрузки, не объявляется нерисующим', async () => {
    // Кэш «видимости» по clientWidth запоминал первый ответ навсегда: игра с
    // заставкой получала 0 кадров с отрисовкой и красный вердикт.
    const lateCfg = await loadConfig(path.join(ROOT, 'fixtures/late-canvas'));
    const { metrics } = await probe(lateCfg, { seconds: 2 });

    assert.ok(metrics.paintFrames >= 20, `кадров с отрисовкой ${metrics.paintFrames}`);
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'pass');
    assert.equal(metrics.verdict, 'pass');
  });

  test('редкая отрисовка видна как редкая — флаг кадра не залипает', async () => {
    // Фикстура рисует раз в 60 кадров. Без сброса флага одна отрисовка
    // пометила бы все последующие кадры, и доля стала бы стопроцентной.
    const blinkCfg = await loadConfig(path.join(ROOT, 'fixtures/blink-game'));
    const { metrics } = await probe(blinkCfg, { seconds: 3 });

    assert.ok(metrics.paintFrames > 0, 'что-то нарисовано');
    assert.ok(metrics.paintFrames < metrics.gameFrames / 4,
      `${metrics.paintFrames} из ${metrics.gameFrames} — доля обязана быть низкой`);
    assert.equal(metrics.checks.find((c) => c.name === 'render').status, 'warn');
  });

  test('упавший start() отменяет замер и оставляет красный след', async () => {
    // По контракту адаптера start() обязателен. Проглоченная ошибка означала
    // замер титульного экрана под видом игры.
    const file = path.join(GAME, 'forge', 'adapter.broken.mjs');
    fs.writeFileSync(file, `export default {
      autostart: true, tickRate: 60,
      install() {
        window.__FORGE__ = {
          ready: true,
          start() { throw new Error('стартовый экран не собрался'); },
          tick() {}, state() { return { over: false, score: 0, level: 1 }; },
        };
      },
    };`);
    try {
      await assert.rejects(
        () => probe({ ...cfg, adapterFile: file }, { seconds: 2 }),
        /start\(\) упал.*стартовый экран не собрался/s,
      );
      const p = JSON.parse(fs.readFileSync(
        path.join(fs.realpathSync(path.join(GAME, '.forge', 'latest-probe')), 'probe.json'), 'utf8'));
      assert.equal(p.verdict, 'fail');
      assert.equal(p.checks[0].name, 'scene');
      assert.match(p.checks[0].detail, /start\(\) упал/);
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('живая игра считается по кадрам игры, а не только пробы', async () => {
    const { metrics } = await probe(cfg, { seconds: 2 });
    assert.ok(metrics.gameFrames >= 20, `кадров игры ${metrics.gameFrames}`);
    assert.ok(metrics.gameFrames <= metrics.frames);
    assert.match(metrics.checks.find((c) => c.name === 'sample').detail, /кадров игры/);
  });

  test('нормальный прогон набирает выборку и проверку sample', async () => {
    const { metrics } = await probe(cfg, { seconds: 2 });
    assert.ok(metrics.frames >= 20, `кадров ${metrics.frames} — выборка должна набраться за 2 секунды`);
    assert.ok(metrics.workSamples > 0 && metrics.frameSamples > 0);
    assert.equal(metrics.checks.find((c) => c.name === 'sample').status, 'pass');
  });
});

describe('бюджет draw calls на живой странице', opts, () => {
  test('редкий тяжёлый кадр валит бюджет, хотя среднее в норме', async () => {
    const spikeCfg = await loadConfig(path.join(ROOT, 'fixtures/spike-frame'));
    const { metrics } = await probe(spikeCfg, { seconds: 4 });
    assert.ok(metrics.drawCallsMedian <= 10, `медиана ${metrics.drawCallsMedian} — обычные кадры дешёвые`);
    assert.ok(metrics.drawCallsMax >= 600, `пик ${metrics.drawCallsMax}`);
    assert.equal(metrics.checks.find((c) => c.name === 'draw-calls').status, 'fail');

    // Отрисовку WebGL признак кадра обязан видеть так же, как 2D: иначе любая
    // WebGL-игра краснела бы «рендер мёртв», а тестов на это не было.
    assert.ok(metrics.paintFrames >= 20, `кадров с отрисовкой ${metrics.paintFrames} — WebGL считается отрисовкой`);
    assert.notEqual(metrics.checks.find((c) => c.name === 'render').status, 'fail');
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

  test('probe --seconds 0 падает, а не рисует зелёный гейт', () => {
    const r = run(['probe', GAME, '--seconds', '0']);
    assert.notEqual(r.code, 0, 'нулевой замер обязан быть ошибкой');
    assert.match(r.out, /положительным числом/);
    assert.doesNotMatch(r.out, /PASS/, 'ни одной зелёной проверки на несостоявшемся замере');
  });

  test('вьюпорт сценария доезжает до CLI, а --viewport его перебивает', () => {
    // Плумбинг CLI → probe: раньше bin подставлял c.viewport, и перебивать
    // сценарий было уже нечем. Тесты на probe() этого не ловили.
    const file = path.join(GAME, 'forge', 'scenarios.mjs');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('export default [', `export default [
      { name: 'phone-peak', viewport: 'phone', selector: '#game', steps: [{ forge: ['start'], tick: 120 }] },`));
    const viewportOf = () => JSON.parse(fs.readFileSync(
      path.join(fs.realpathSync(path.join(GAME, '.forge', 'latest-probe')), 'probe.json'), 'utf8')).viewport;
    try {
      assert.equal(run(['probe', GAME, '--seconds', '1', '--scenario', 'phone-peak']).code, 0);
      assert.equal(viewportOf(), 'phone', 'вьюпорт сценария');

      assert.equal(run(['probe', GAME, '--seconds', '1', '--scenario', 'phone-peak', '--viewport', 'desktop']).code, 0);
      assert.equal(viewportOf(), 'desktop', 'явный флаг важнее');

      // Форма --key=value: раньше ключ ломался, сцена не готовилась, вердикт был зелёным
      assert.equal(run(['probe', GAME, '--seconds', '1', '--scenario=phone-peak']).code, 0);
      assert.equal(viewportOf(), 'phone', '--scenario=имя обязан работать так же');
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  test('флаг без значения — ошибка, а не тихое умолчание', () => {
    // `forge probe game --viewport $VP` с пустой переменной мерил другой класс
    // устройств и оставался зелёным.
    const vp = run(['probe', GAME, '--seconds', '1', '--viewport', '--strict']);
    assert.notEqual(vp.code, 0);
    assert.match(vp.out, /--viewport требует значение/);

    const sc = run(['probe', GAME, '--seconds', '1', '--scenario', '--strict']);
    assert.notEqual(sc.code, 0);
    assert.match(sc.out, /--scenario требует значение/);
  });

  test('сорванная подготовка сцены оставляет красный след, а не вчерашний зелёный', () => {
    const file = path.join(GAME, 'forge', 'scenarios.mjs');
    const original = fs.readFileSync(file, 'utf8');
    const probeJson = () => JSON.parse(fs.readFileSync(
      path.join(fs.realpathSync(path.join(GAME, '.forge', 'latest-probe')), 'probe.json'), 'utf8'));

    assert.equal(run(['probe', GAME, '--seconds', '1']).code, 0);
    assert.equal(probeJson().verdict, 'pass', 'сначала зелёный прогон');

    fs.writeFileSync(file, original.replace('export default [', `export default [
      { name: 'badprep', viewport: 'desktop', selector: '#game', steps: [
        { forge: ['start'], tick: 60 },
        { expect: { fn: () => window.__FORGE__.state().score > 1e9, msg: 'сцена доведена до пика' } },
      ] },`));
    try {
      const r = run(['probe', GAME, '--seconds', '1', '--scenario', 'badprep']);
      assert.notEqual(r.code, 0);
      const p = probeJson();
      assert.equal(p.verdict, 'fail', 'latest-probe обязан показывать сорванный замер, а не прошлый зелёный');
      assert.equal(p.checks[0].name, 'scene');
      assert.match(p.checks[0].detail, /сцена доведена до пика/);
    } finally {
      fs.writeFileSync(file, original);
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
