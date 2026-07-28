import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, evaluateBudgets } from '../src/probe.mjs';

/** Сырьё в том виде, в каком его отдаёт страница. */
const raw = ({ work = [1, 1, 1], draws = [5, 5, 5], drawsMax = 5, frames = 3, drawsTotal = 15 } = {}) => ({
  frames, longFrames: 0, times: [8.3, 8.3, 8.3],
  work, workTotal: work.reduce((a, b) => a + b, 0), workMax: Math.max(...work),
  draws, drawsMax, drawsTotal,
  elapsedMs: 1000, heapBytes: 10 * 1048576, dpr: 2, state: null,
});

const cfg = (budgets = {}) => ({ name: 'T', renderer: '2d', budgets });
const opts = { viewport: 'desktop', seconds: 4 };

describe('бюджет draw calls', () => {
  test('пик ловится, даже когда среднее крошечное', () => {
    // Ровно repro из ревью: один кадр на 600 вызовов среди 99 дешёвых.
    // Среднее ≈ 12, и по нему бюджет 150 «проходил» бы.
    const draws = [...Array(99).fill(6), 600];
    const m = computeMetrics(raw({ draws, drawsMax: 600, frames: 100, drawsTotal: 1194 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.drawCallsAvg, 12, 'среднее действительно маленькое');
    assert.equal(m.drawCallsMax, 600);
    // Один кадр из ста — это ровно 1% выборки, и p99 его теряет.
    // Поэтому гейт смотрит на максимум: игрок этот фриз увидит.
    assert.equal(m.checks.find((c) => c.name === 'draw-calls').status, 'fail');
    assert.equal(m.verdict, 'fail');
  });

  test('ровный профиль в пределах бюджета проходит', () => {
    const m = computeMetrics(raw({ draws: Array(100).fill(80), drawsMax: 80, frames: 100, drawsTotal: 8000 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.checks.find((c) => c.name === 'draw-calls').status, 'pass');
  });

  test('единственный тяжёлый кадр среди сотни всё равно валит бюджет', () => {
    // Отдельная проверка именно на границе, где p99 бесполезен
    const draws = [...Array(99).fill(10), 400];
    const m = computeMetrics(raw({ draws, drawsMax: 400, frames: 100, drawsTotal: 1390 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.drawCallsP99, 10, 'p99 действительно не видит этот кадр');
    assert.equal(m.checks.find((c) => c.name === 'draw-calls').status, 'fail');
  });

  test('превышение в полтора раза — предупреждение, не провал', () => {
    const m = computeMetrics(raw({ draws: Array(100).fill(200), drawsMax: 200, frames: 100, drawsTotal: 20000 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.equal(m.checks.find((c) => c.name === 'draw-calls').status, 'warn');
  });

  test('без бюджета проверки нет — 2D-играм она бессмысленна', () => {
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}) });
    assert.equal(m.checks.find((c) => c.name === 'draw-calls'), undefined);
  });
});

describe('headroom', () => {
  test('считается от настроенного бюджета, а не от 16.7', () => {
    // 3D-прототипы задают frameMs: 8 — при 10 мс работы запаса уже нет
    const m = computeMetrics(raw({ work: Array(10).fill(10) }), { ...opts, cfg: cfg({ frameMs: 8 }) });
    assert.equal(m.budgetMs, 8);
    assert.ok(m.headroom < 1, `запас ×${m.headroom} — при бюджете 8 мс и работе 10 мс его нет`);
    assert.equal(m.checks.find((c) => c.name === 'frame-work').status, 'warn');
  });

  test('умолчание 16.7 сохраняется, когда бюджет не задан', () => {
    const m = computeMetrics(raw({ work: Array(10).fill(1) }), { ...opts, cfg: cfg({}) });
    assert.equal(m.budgetMs, 16.7);
    assert.equal(m.headroom, 16.7);
  });
});

describe('evaluateBudgets', () => {
  const base = {
    frameWorkMs: 1, frameWorkP99Ms: 2, frameWorkMaxMs: 3, mainThreadBusy: 0.1, headroom: 16,
    errorCount: 0, errors: [], bundleKb: 10, loadMs: 100,
    drawCallsP99: 10, drawCallsMax: 12, drawCallsMedian: 9, longFrames: 0, frames: 100,
  };

  test('софтверный WebGL понижает провал по кадру до предупреждения', () => {
    const hard = evaluateBudgets({ ...base, frameWorkMs: 100, softwareGl: false }, { frameMs: 16.7 });
    const soft = evaluateBudgets({ ...base, frameWorkMs: 100, softwareGl: true }, { frameMs: 16.7 });
    assert.equal(hard.find((c) => c.name === 'frame-work').status, 'fail');
    assert.equal(soft.find((c) => c.name === 'frame-work').status, 'warn');
    assert.match(soft.find((c) => c.name === 'frame-work').detail, /софтверный WebGL/);
  });

  test('мёртвый кадр — провал', () => {
    const checks = evaluateBudgets({ ...base, canvas: { distinctColors: 1, minLum: 0, maxLum: 0 } }, {});
    assert.equal(checks.find((c) => c.name === 'frame-alive').status, 'fail');
  });

  test('ошибка декодирования кадра не выдаётся за мёртвый кадр', () => {
    const checks = evaluateBudgets({ ...base, canvas: { error: 'не PNG' } }, {});
    assert.equal(checks.find((c) => c.name === 'frame-alive'), undefined);
  });
});
