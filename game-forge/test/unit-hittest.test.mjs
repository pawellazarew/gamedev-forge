import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeHittable, hittableFor, sweepScenarios, hitMessage, hittableSummary, DEFAULT_HIT_VIEWPORTS,
} from '../src/hittest.mjs';
import { loadConfig } from '../src/harness.mjs';

describe('normalizeHittable — одна форма конфига', () => {
  test('короткая запись массивом получает три вьюпорта по умолчанию', () => {
    const h = normalizeHittable(['#code', '#shop']);
    assert.deepEqual(h.selectors, ['#code', '#shop']);
    assert.deepEqual(h.viewports, DEFAULT_HIT_VIEWPORTS);
    assert.deepEqual(DEFAULT_HIT_VIEWPORTS, ['desktop', 'phoneLandscape', 'phone']);
    assert.deepEqual(h.setup, []);
    assert.equal(h.settleMs, 1000);
  });

  test('полная запись сохраняет вьюпорты и шаги подготовки', () => {
    const setup = [{ eval: 'skip()' }];
    const h = normalizeHittable({ selectors: ['#a'], viewports: ['tablet'], setup });
    assert.deepEqual(h.viewports, ['tablet']);
    assert.equal(h.setup, setup);
  });

  test('нет секции — защиты нет, и это не ошибка', () => {
    assert.equal(normalizeHittable(undefined), null);
    assert.equal(normalizeHittable(null), null);
    assert.equal(normalizeHittable(false), null);
  });

  test('пустой список не выключает защиту молча, а падает', () => {
    // Иначе опечатка в имени ключа или `selectors: []` давали бы зелёный
    // прогон без единой проверки
    assert.throws(() => normalizeHittable([]), /непустой массив/);
    assert.throws(() => normalizeHittable({ selectors: [] }), /непустой массив/);
    assert.throws(() => normalizeHittable({ selectors: ['#a', ''] }), /непустой массив/);
    assert.throws(() => normalizeHittable({ selector: '#a' }), /непустой массив/);
  });

  test('опечатка во вьюпорте — ошибка при загрузке, а не посреди прогона', () => {
    assert.throws(() => normalizeHittable({ selectors: ['#a'], viewports: ['phoneLandscpe'] }), /Неизвестный вьюпорт/);
    assert.throws(() => normalizeHittable({ selectors: ['#a'], viewports: 'phone' }), /массив имён/);
    assert.throws(() => normalizeHittable({ selectors: ['#a'], setup: { eval: 'x' } }), /массив шагов/);
    assert.throws(() => normalizeHittable({ selectors: ['#a'], settleMs: '2s' }), /settleMs/);
    assert.equal(normalizeHittable({ selectors: ['#a'], settleMs: 3000 }).settleMs, 3000);
  });

  test('loadConfig прогоняет секцию через ту же проверку', async () => {
    // Папка на каждый конфиг: loadConfig импортирует с меткой времени, и два
    // конфига в одном файле за одну миллисекунду читались бы из кэша
    const load = (body) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hit-'));
      fs.writeFileSync(path.join(dir, 'forge.config.mjs'), `export default ${body};`);
      return loadConfig(dir);
    };
    await assert.rejects(() => load('{ hittable: { selectors: ["#a"], viewports: ["nope"] } }'), /Неизвестный вьюпорт "nope"/);
    assert.deepEqual((await load('{ hittable: ["#a"] }')).hittable.selectors, ['#a']);
    assert.equal((await load('{}')).hittable, null);
  });
});

describe('hittableFor — что проверять в конце сценария', () => {
  const cfg = { hittable: normalizeHittable(['#code', '#shop']) };

  test('по умолчанию — список конфига', () => {
    assert.deepEqual(hittableFor({ name: 'x' }, cfg), ['#code', '#shop']);
  });

  test('сценарий с модалкой в конце отказывается от проверки', () => {
    assert.deepEqual(hittableFor({ hittable: false }, cfg), []);
  });

  test('сценарий может сузить список или объявить свой без конфига', () => {
    assert.deepEqual(hittableFor({ hittable: ['#code'] }, cfg), ['#code']);
    assert.deepEqual(hittableFor({ hittable: ['#go'] }, {}), ['#go']);
  });

  test('ни конфига, ни сценария — проверять нечего', () => {
    assert.deepEqual(hittableFor({}, {}), []);
  });
});

describe('sweepScenarios — обход по вьюпортам', () => {
  test('по сценарию на вьюпорт, шаги — из setup', () => {
    const setup = [{ eval: 'skip()' }];
    const list = sweepScenarios({ hittable: normalizeHittable({ selectors: ['#a'], setup }) });
    assert.deepEqual(list.map((s) => s.name), ['hittable@desktop', 'hittable@phoneLandscape', 'hittable@phone']);
    assert.deepEqual(list.map((s) => s.viewport), ['desktop', 'phoneLandscape', 'phone']);
    for (const s of list) assert.equal(s.steps, setup);
  });

  test('явный --viewport схлопывает обход до одного прогона', () => {
    // Флаг перебивает вьюпорт сценария — три одинаковых прогона подряд
    // ничего бы не добавили
    const list = sweepScenarios({ hittable: normalizeHittable(['#a']) }, 'tablet');
    assert.deepEqual(list.map((s) => s.name), ['hittable@tablet']);
  });

  test('без секции обхода нет, пустой список вьюпортов его выключает', () => {
    assert.deepEqual(sweepScenarios({}), []);
    assert.deepEqual(sweepScenarios({ hittable: normalizeHittable({ selectors: ['#a'], viewports: [] }) }), []);
  });
});

describe('hitMessage — что мешает и что чинить', () => {
  test('перекрытие называет верхний элемент, его слой и слой цели', () => {
    const msg = hitMessage('#shop', {
      reason: 'covered', x: 1055.4, y: 467, hit: 'img.bg', owner: 'div#art',
      layer: { el: 'div#art', z: '3' }, self: null,
    });
    assert.match(msg, /«#shop» перекрыт/);
    assert.match(msg, /\(1055, 467\)/);
    assert.match(msg, /img\.bg внутри div#art/);
    assert.match(msg, /слой div#art, z-index 3/);
    assert.match(msg, /своего z-index нет/);
  });

  test('у цели со своим слоем виден её z-index — видно, что проиграла', () => {
    const msg = hitMessage('#tabs', {
      reason: 'covered', x: 1, y: 2, hit: 'div#art', owner: null,
      layer: { el: 'div#art', z: '3' }, self: { el: 'div#tabs', z: '2' },
    });
    assert.match(msg, /сверху div#art \(слой div#art, z-index 3\)/);
    assert.match(msg, /z-index 2 у div#tabs/);
  });

  test('остальные причины различимы между собой', () => {
    assert.match(hitMessage('#a', { reason: 'missing' }), /не найден/);
    assert.match(hitMessage('#a', { reason: 'invisible', w: 0, h: 0 }), /не виден: 0×0/);
    assert.match(hitMessage('#a', { reason: 'invisible', w: 10, h: 10, visibility: 'hidden' }), /visibility: hidden/);
    assert.match(hitMessage('#a', { reason: 'offscreen', w: 10, h: 10, rect: [900, 0], vw: 390, vh: 844 }), /за экраном.*390×844/);
    assert.match(hitMessage('#a', { reason: 'offscreen', w: 10, h: 10, rect: [0, 900], vw: 390, vh: 844, locked: 'div#list' }),
      /докрутить туда нельзя — overflow: hidden у div#list/);
    assert.match(hitMessage('#a', { reason: 'disabled' }), /выключен/);
    assert.match(hitMessage('.up', { reason: 'invisible', w: 0, h: 0, count: 4 }), /все 4 совпадения/);
    assert.match(hitMessage('#a', { reason: 'no-pointer-events' }), /pointer-events: none/);
    assert.match(hitMessage('#a', { reason: 'bad-selector', error: 'Unexpected token' }), /неверный селектор/);
  });
});

describe('hittableSummary — одна проверка для probe', () => {
  test('провал собирает все причины', () => {
    const c = hittableSummary([
      { name: 'кликабелен «#a»', status: 'fail', detail: 'A перекрыт', selector: '#a' },
      { name: 'кликабелен «#b»', status: 'pass', detail: '', selector: '#b' },
    ]);
    assert.equal(c.name, 'hittable');
    assert.equal(c.status, 'fail');
    assert.equal(c.detail, 'A перекрыт');
  });

  test('успех перечисляет, что проверено', () => {
    const c = hittableSummary([{ status: 'pass', selector: '#a' }, { status: 'pass', selector: '#b' }, { status: 'pass', selector: '#a' }]);
    assert.equal(c.status, 'pass');
    assert.match(c.detail, /#a, #b/);
  });
});
