import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/harness.mjs';
import { probe } from '../src/probe.mjs';
import { runScenarios } from '../src/scenario.mjs';
import { findChromium } from '../src/browser.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const GAME = path.join(ROOT, 'fixtures/covered-button');
const FORGE = path.join(ROOT, 'game-forge/bin/forge.mjs');

const hasBrowser = !!findChromium();
const opts = { skip: hasBrowser ? false : 'Chromium не установлен: npx playwright install chromium' };

// Фикстура повторяет bum2billionaire 2026-09-23: арт с z-index 3 во весь
// экран, урок на первом шаге поднимает кнопку над ним, после первого клика
// кнопка опускается под арт. DOM-клик при этом работает — так play и зеленел.
const COVERED = /«#go» перекрыт: в точке \(\d+, \d+\) сверху div\.hero внутри div#art \(слой div#art, z-index 3\)/;

let cfg;
before(async () => { cfg = await loadConfig(GAME); });

describe('кликабельность: сценарии', opts, () => {
  let summary;
  const byName = (n) => summary.scenarios.find((s) => s.scenario === n);
  const failed = (n) => byName(n).checks.filter((c) => c.status === 'fail');

  before(async () => { ({ summary } = await runScenarios(cfg, { kind: 'play' })); });

  test('перекрытая кнопка валит прогон целиком', () => {
    assert.equal(summary.status, 'fail');
  });

  test('здоровая половина проходит: клик мышью на десктопе, касание на телефоне', () => {
    // Ложный красный блокирует работу так же надёжно, как ложный зелёный её
    // пропускает. expect внутри сценариев сверяет и число кликов, и тип ввода.
    for (const n of ['click-ok', 'tap-ok']) {
      assert.equal(byName(n).status, 'pass', `${n}: ${JSON.stringify(failed(n))}`);
    }
    assert.equal(byName('tap-ok').viewport, 'phone');
  });

  test('второй настоящий клик упирается в арт и называет его', () => {
    const f = failed('second-click-covered');
    assert.equal(f.length, 1);
    assert.equal(f[0].name, 'шаг 1', 'номер шага, а не число проверок');
    assert.match(f[0].detail, COVERED);
    assert.match(f[0].detail, /клик 2 из 2/, 'первый клик прошёл — видно, какой именно упал');
  });

  test('DOM-клики зеленят шаги, ловит только проверка в конце сценария', () => {
    const sc = byName('dom-click-hides-it');
    assert.equal(sc.checks.find((c) => /DOM-клики/.test(c.name)).status, 'pass',
      'шаг через el.click() проходит сквозь арт — ровно та дыра, что пропустила bum2billionaire');
    const hit = sc.checks.find((c) => c.name === 'кликабелен «#go»');
    assert.equal(hit.status, 'fail');
    assert.match(hit.detail, COVERED);
  });

  test('сценарий с hittable: false от проверки освобождён', () => {
    const sc = byName('opted-out');
    assert.equal(sc.status, 'pass');
    assert.equal(sc.checks.some((c) => c.name.startsWith('кликабелен')), false);
  });

  test('обход hittable@ покрывает десктоп и оба положения телефона', () => {
    for (const vp of ['desktop', 'phoneLandscape', 'phone']) {
      const sc = byName(`hittable@${vp}`);
      assert.ok(sc, `обход ${vp} не запускался`);
      assert.equal(sc.viewport, vp);
      assert.equal(sc.status, 'fail');
      assert.match(failed(`hittable@${vp}`)[0].detail, COVERED);
    }
  });

  test('на провал снят кадр страницы с подписью, что перекрыто', () => {
    const shot = byName('dom-click-hides-it').shots.find((s) => s.label === 'hittable');
    assert.ok(shot && fs.existsSync(shot.file), 'кадра провала нет');
    assert.ok(fs.statSync(shot.file).size > 500);
    assert.match(shot.note, /div#art/);
  });
});

describe('кликабельность: обход без поломки', opts, () => {
  test('свежий игрок — кнопка поднята уроком, обход зелёный на всех вьюпортах', async () => {
    // Та же страница без шага подготовки: урок держит кнопку над артом.
    // Если обход краснеет и здесь, он ловит не перекрытие, а что-то своё.
    const fresh = { ...cfg, hittable: { ...cfg.hittable, setup: [] } };
    const { summary } = await runScenarios(fresh, { kind: 'play', only: null });
    const sweep = summary.scenarios.filter((s) => s.scenario.startsWith('hittable@'));
    assert.equal(sweep.length, 3);
    for (const s of sweep) assert.equal(s.status, 'pass', `${s.scenario}: ${JSON.stringify(s.checks)}`);
  });

  test('--only выбирает обход по имени и не тащит остальное', async () => {
    const { summary } = await runScenarios(cfg, { kind: 'play', only: 'hittable@phone' });
    assert.deepEqual(summary.scenarios.map((s) => s.scenario), ['hittable@phone']);
  });
});

describe('кликабельность: click по селектору', opts, () => {
  test('идёт через ту же проверку и падает быстро, а не через 30 секунд', async () => {
    // page.click Playwright тоже замечал перекрытие, но ждал полминуты и
    // сообщал «intercepts pointer events» без слоя и z-index
    const file = path.join(GAME, 'forge', 'scenarios.click.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'legacy-click', viewport: 'desktop', hittable: false,
      steps: [{ click: '#go', times: 2 }],
    }];`);
    try {
      const t0 = Date.now();
      const { summary } = await runScenarios({ ...cfg, scenariosFile: file, hittable: null }, { kind: 'play' });
      assert.ok(Date.now() - t0 < 20000, `прогон шёл ${Date.now() - t0} мс`);
      const f = summary.scenarios[0].checks.filter((c) => c.status === 'fail');
      assert.equal(f.length, 1);
      assert.match(f[0].detail, COVERED);
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('шаг hittable проверяет без клика и не обрывает сценарий', async () => {
    const file = path.join(GAME, 'forge', 'scenarios.step.mjs');
    fs.writeFileSync(file, `export default [{
      name: 'step-check', viewport: 'desktop', hittable: false,
      steps: [
        { hittable: '#go' },
        { eval: 'window.__game.clickGo()' },
        { hittable: ['#go', '#nope'] },
        { expect: { fn: () => window.clicks === 1, msg: 'сценарий дошёл до конца' } },
      ],
    }];`);
    try {
      const { summary } = await runScenarios({ ...cfg, scenariosFile: file, hittable: null }, { kind: 'play' });
      const checks = summary.scenarios[0].checks;
      assert.deepEqual(checks.map((c) => c.status), ['pass', 'fail', 'fail', 'pass']);
      assert.match(checks[1].detail, COVERED);
      assert.match(checks[2].detail, /«#nope» не найден/);
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('кликабельность: probe --scenario', opts, () => {
  test('перекрытие в конце сцены красит вердикт, замер при этом идёт', async () => {
    const { metrics } = await probe(cfg, { seconds: 1, scenario: 'dom-click-hides-it' });
    const hit = metrics.checks.find((c) => c.name === 'hittable');
    assert.equal(hit.status, 'fail');
    assert.match(hit.detail, COVERED);
    assert.equal(metrics.verdict, 'fail');
    assert.ok(metrics.frames > 0, 'находка, а не сорванная сцена: кадры пробы сняты');
  });

  test('здоровая сцена проходит', async () => {
    const { metrics } = await probe(cfg, { seconds: 1, scenario: 'click-ok' });
    assert.equal(metrics.checks.find((c) => c.name === 'hittable').status, 'pass');
    assert.notEqual(metrics.verdict, 'fail');
  });

  test('без сценария probe кликабельность не проверяет', async () => {
    // Проверка привязана к концу сценария: без него неизвестно, в каком
    // состоянии игра обязана быть кликабельной
    const { metrics } = await probe(cfg, { seconds: 1 });
    assert.equal(metrics.checks.find((c) => c.name === 'hittable'), undefined);
  });
});

describe('кликабельность: достижимость', opts, () => {
  // Находки ревью PR #9: касание мимо кнопки на широкой странице, ложный
  // красный на строке прокручиваемого списка, ложный зелёный на кнопке в
  // контейнере с overflow: hidden и на выключенной кнопке, 2 с ожидания на
  // вечной анимации.
  let summary, reachCfg;
  const byName = (n) => summary.scenarios.find((s) => s.scenario === n);
  const failOf = (n) => byName(n).checks.find((c) => c.status === 'fail');

  before(async () => {
    reachCfg = await loadConfig(path.join(ROOT, 'fixtures/hit-reach'));
    ({ summary } = await runScenarios(reachCfg, { kind: 'play' }));
  });

  test('на телефоне касание попадает в кнопку за краем экрана, списке и ниже экрана', () => {
    // Раньше видимое считалось по innerWidth: на странице шире экрана
    // касание уходило мимо кнопки, а шаг оставался зелёным
    for (const n of ['reach-phone', 'reach-desktop']) {
      assert.equal(byName(n).status, 'pass', `${n}: ${JSON.stringify(failOf(n))}`);
    }
  });

  test('клик ждёт, пока кнопка включится, и не тормозит на вечной анимации', () => {
    assert.equal(byName('pulse').status, 'pass', JSON.stringify(failOf('pulse')));
  });

  test('выключенная кнопка — провал клика с причиной, а не тихий пропуск', () => {
    assert.match(failOf('dead').detail, /«#dead» выключен \(disabled\)/);
  });

  test('туда, куда игрок не докрутит, проверка тоже не докручивает', () => {
    // scrollIntoView крутит и overflow: hidden — без отката проверка
    // зеленела бы на недостижимой кнопке
    assert.match(failOf('locked').detail, /«#inlocked» за экраном игрока.*overflow: hidden у div#locked/);
    assert.match(failOf('page-locked').detail, /«#below» за экраном игрока.*overflow: hidden у body/);
  });

  test('проваленный шаг hittable в probe — находка, а не сорванная сцена', async () => {
    const { metrics } = await probe(reachCfg, { seconds: 1, scenario: 'locked' });
    const hit = metrics.checks.find((c) => c.name === 'hittable');
    assert.equal(hit.status, 'fail');
    assert.match(hit.detail, /div#locked/);
    assert.ok(metrics.frames > 0, 'замер состоялся');
    assert.equal(metrics.verdict, 'fail');
  });
});

describe('кликабельность: CLI', opts, () => {
  test('play на перекрытой кнопке выходит с кодом 2', () => {
    let code = 0, out = '';
    try {
      out = execFileSync('node', [FORGE, 'play', GAME], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
      out = (e.stdout || '') + (e.stderr || '');
    }
    assert.equal(code, 2, out.slice(-800));
    assert.match(out, /div#art/);
  });
});
