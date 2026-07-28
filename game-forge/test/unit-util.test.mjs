import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, num, mean, median, percentile, stdev, wilson, filterNoise, runStamp,
} from '../src/util.mjs';

describe('parseArgs', () => {
  test('пары --key value и одиночные флаги', () => {
    const a = parseArgs(['games/x', '--runs', '20', '--headed', '--bot', 'veteran']);
    assert.deepEqual(a._, ['games/x']);
    assert.equal(a.runs, '20');
    assert.equal(a.headed, true);
    assert.equal(a.bot, 'veteran');
  });

  test('значение, похожее на флаг, не съедает следующий ключ', () => {
    const a = parseArgs(['--strict', '--seed', '5']);
    assert.equal(a.strict, true);
    assert.equal(a.seed, '5');
  });

  test('num подставляет умолчание для мусора', () => {
    assert.equal(num('12', 1), 12);
    assert.equal(num(undefined, 7), 7);
    assert.equal(num('abc', 3), 3);
    assert.equal(num(true, 9), 9, 'флаг без значения — не число');
  });
});

describe('статистика', () => {
  test('median на чётной и нечётной длине', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
  });

  test('median устойчива к выбросу, mean — нет', () => {
    const xs = [10, 10, 10, 10, 1000];
    assert.equal(median(xs), 10);
    assert.ok(mean(xs) > 200, 'среднее уезжает — потому и меряем медианой');
  });

  test('percentile берёт границы правильно', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(xs, 50), 50);
    assert.equal(percentile(xs, 99), 99);
    assert.equal(percentile(xs, 100), 100);
    assert.equal(percentile([], 50), 0);
  });

  test('stdev', () => {
    assert.equal(stdev([2, 2, 2]), 0);
    assert.ok(Math.abs(stdev([1, 3]) - 1) < 1e-9);
    assert.equal(stdev([5]), 0, 'по одному значению разброса нет');
  });
});

describe('wilson — доверительный интервал доли', () => {
  test('интервал накрывает точечную оценку', () => {
    const w = wilson(6, 10);
    assert.equal(w.p, 0.6);
    assert.ok(w.lo < 0.6 && w.hi > 0.6);
  });

  test('на малой выборке интервал шире, чем на большой', () => {
    const small = wilson(6, 10);
    const big = wilson(600, 1000);
    assert.ok((small.hi - small.lo) > (big.hi - big.lo) * 5,
      'иначе шум выдавался бы за вывод');
  });

  test('нулевые успехи не дают нулевой верхней границы', () => {
    const w = wilson(0, 12);
    assert.equal(w.p, 0);
    assert.ok(w.hi > 0.2, '0/12 — это ещё не «невозможно»');
    assert.equal(w.lo, 0);
  });

  test('пустая выборка не ломает расчёт', () => {
    assert.deepEqual(wilson(0, 0), { p: 0, lo: 0, hi: 0 });
  });

  test('границы не вылезают за [0,1]', () => {
    const w = wilson(10, 10);
    assert.ok(w.hi <= 1 && w.lo >= 0);
  });
});

describe('filterNoise', () => {
  const noise = [
    { kind: 'http', text: 'http://x/favicon.ico 404' },
    { kind: 'console.error', text: 'Failed to load resource: 404 (Not Found)' },
    { kind: 'console.warning', text: '[.WebGL-0x1]GL Driver Message (OpenGL, Performance): GPU stall due to ReadPixels' },
  ];

  test('favicon и парный console.error отсеиваются', () => {
    assert.equal(filterNoise(noise).length, 0);
  });

  test('настоящая ошибка сохраняется', () => {
    const errs = filterNoise([...noise, { kind: 'pageerror', text: 'TypeError: x is not a function' }]);
    assert.equal(errs.length, 1);
    assert.match(errs[0].text, /TypeError/);
  });

  test('при реальном сетевом сбое console.error про ресурс НЕ глушится', () => {
    const errs = filterNoise([
      { kind: 'http', text: 'http://x/assets/atlas.png 404' },
      { kind: 'console.error', text: 'Failed to load resource: 404 (Not Found)' },
    ]);
    assert.equal(errs.length, 2, 'потеря ассета — дефект, а не шум');
  });
});

describe('runStamp', () => {
  test('формат YYYYMMDD-HHMMSS и лексикографическая сортировка', () => {
    const a = runStamp(new Date(2026, 6, 28, 9, 5, 3));
    const b = runStamp(new Date(2026, 6, 28, 10, 5, 3));
    assert.equal(a, '20260728-090503');
    assert.ok(a < b, 'метки должны сортироваться как строки');
  });
});
