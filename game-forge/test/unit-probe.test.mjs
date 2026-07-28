import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, evaluateBudgets, prepareScene, probe, MIN_FRAMES } from '../src/probe.mjs';
import { resolveViewport } from '../src/browser.mjs';

/** Сырьё в том виде, в каком его отдаёт страница. */
const raw = ({
  work = Array(100).fill(1), draws = Array(100).fill(5), drawsMax = 5,
  frames = 100, gameFrames = frames, paintFrames = gameFrames,
  drawsTotal = 500, times = Array(100).fill(8.3), longFrames = 0,
} = {}) => ({
  frames, gameFrames, paintFrames, longFrames, times,
  work, workTotal: work.reduce((a, b) => a + b, 0), workMax: work.length ? Math.max(...work) : 0,
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
    gameFrames: 100, workSamples: 100, frameSamples: 100, longFrameRatio: 0, seconds: 4,
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

describe('достаточность выборки', () => {
  const sample = (m) => m.checks.find((c) => c.name === 'sample');

  test('ноль кадров — провал, а не зелёный прогон', () => {
    // Repro из ревью: `--seconds 0` давал PASS, 0/0 кадров и код выхода 0,
    // то есть performance gate, который проходит любая игра.
    const empty = raw({ work: [], draws: [], drawsMax: 0, frames: 0, drawsTotal: 0, times: [] });
    const m = computeMetrics(empty, { ...opts, seconds: 0.001, cfg: cfg({ drawCalls: 150 }) });

    assert.equal(m.frames, 0);
    assert.equal(m.frameWorkMs, 0, 'нулевая работа сама по себе выглядит идеально');
    assert.equal(m.checks.find((c) => c.name === 'frame-work').status, 'pass',
      'именно поэтому остальные проверки на пустой выборке зеленеют');
    assert.equal(sample(m).status, 'fail');
    assert.equal(m.verdict, 'fail', 'вердикт обязан краснеть на пустом замере');
  });

  test('мёртвый цикл рендера ловится, хотя кадры пробы идут', () => {
    // Второе ревью: проба крутит СВОЙ rAF и насчитывает кадры странице,
    // которая нарисовала один раз и больше не перерисовывается.
    // Кадры пробы для гейта поэтому не годятся — считаем кадры игры.
    const dead = raw({ work: Array(90).fill(0), frames: 90, gameFrames: 0 });
    const m = computeMetrics(dead, { ...opts, seconds: 3, cfg: cfg({}) });

    assert.equal(m.frames, 90, 'кадры пробы идут');
    assert.equal(m.gameFrames, 0, 'а игра не нарисовала ни одного');
    assert.equal(m.workSamples, 90, 'замеры работы при этом «есть» — все нулевые');
    assert.equal(sample(m).status, 'fail');
    assert.match(sample(m).detail, /не нарисовала ни одного кадра/);
    assert.equal(m.verdict, 'fail');
  });

  test('кадры есть, а замеров работы нет — тоже провал, и причина другая', () => {
    // Все значения work отфильтрованы как невалидные: счётчик сломан.
    const m = computeMetrics(raw({ work: Array(50).fill(9e9), frames: 50 }), { ...opts, cfg: cfg({}) });
    assert.equal(m.workSamples, 0);
    assert.equal(sample(m).status, 'fail');
    assert.match(sample(m).detail, /инструментирование кадра сломано/);
    assert.doesNotMatch(sample(m).detail, /--seconds/, 'совет поднять --seconds тут лечит не то');
    assert.equal(m.verdict, 'fail');
  });

  test('кадров впритык — предупреждение: число есть, доверия нет', () => {
    const thin = raw({ work: Array(8).fill(1), draws: Array(8).fill(5), frames: 8, times: Array(8).fill(8.3) });
    const m = computeMetrics(thin, { ...opts, seconds: 0.2, cfg: cfg({}) });
    assert.equal(sample(m).status, 'warn');
    assert.equal(m.verdict, 'warn');
    assert.match(sample(m).detail, /выборка тоньше/);
  });

  test('обрезанная выборка на длинном прогоне — предупреждение', () => {
    // Счётчики работы копятся до 4000 записей, а кадры считаются дальше:
    // медиана и p99 описывают начало окна, а не весь прогон.
    const soak = raw({ work: Array(4000).fill(1), draws: Array(4000).fill(5), frames: 5400, times: Array(4000).fill(8.3) });
    const m = computeMetrics(soak, { ...opts, seconds: 120, cfg: cfg({}) });
    assert.equal(sample(m).status, 'warn');
    assert.match(sample(m).detail, /начало окна/);
  });

  test('полноценная выборка проходит и попадает в метрики', () => {
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}) });
    assert.equal(m.workSamples, 100);
    assert.equal(m.frameSamples, 100);
    assert.equal(m.gameFrames, 100);
    assert.equal(sample(m).status, 'pass');
    assert.equal(m.verdict, 'pass');
  });

  test('граница MIN_FRAMES проверяется, а не подразумевается', () => {
    const at = (frames) => computeMetrics(
      raw({ work: Array(frames).fill(1), draws: Array(frames).fill(5), frames, times: Array(frames).fill(8.3) }),
      { ...opts, cfg: cfg({}) },
    );
    assert.equal(sample(at(MIN_FRAMES - 1)).status, 'fail');
    assert.notEqual(sample(at(MIN_FRAMES)).status, 'fail');
  });

  test('probe.json без gameFrames (прогон до этой правки) читается по-старому', () => {
    const legacy = { frames: 100, workSamples: 100, frameSamples: 100, seconds: 4, frameWorkMs: 1, frameWorkP99Ms: 2, errorCount: 0, errors: [] };
    assert.equal(evaluateBudgets(legacy, {}).find((c) => c.name === 'sample').status, 'pass');
  });
});

describe('живой цикл против живого рендера', () => {
  const render = (m) => m.checks.find((c) => c.name === 'render');
  /** Зомби: rAF вызывается каждый кадр и не рисует ничего. */
  const zombie = raw({ frames: 359, gameFrames: 359, paintFrames: 0, work: Array(359).fill(0.01), times: Array(359).fill(8.3) });

  test('пустой rAF не считается отрисовкой', () => {
    // Из ревью: пустой `requestAnimationFrame(loop)` давал 143/143 кадров игры
    // и зелёный вердикт на застывшей картинке. Кадров игры для гейта мало.
    const m = computeMetrics(zombie, { ...opts, seconds: 3, cfg: cfg({}), pixelChange: 0 });

    assert.equal(m.gameFrames, 359, 'цикл жив');
    assert.equal(m.paintFrames, 0, 'а нарисовано ничего');
    assert.equal(m.checks.find((c) => c.name === 'sample').status, 'pass', 'по кадрам игры всё в порядке');
    assert.equal(render(m).status, 'fail');
    assert.match(render(m).detail, /рендер мёртв/);
    assert.equal(m.verdict, 'fail');
  });

  test('меняющиеся пиксели без команд рисования — предупреждение, не приговор', () => {
    // Воркер, WebGPU, DOM/CSS: инструментирование их не видит, но игра живёт.
    // Красный вердикт тут был бы враньём про игру.
    const m = computeMetrics(zombie, { ...opts, seconds: 3, cfg: cfg({}), pixelChange: 0.02 });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /мимо 2D\/WebGL/);
  });

  test('пиксели не сравнивали — тоже не приговор', () => {
    const m = computeMetrics(zombie, { ...opts, seconds: 3, cfg: cfg({}) });
    assert.equal(m.pixelChange, null);
    assert.equal(render(m).status, 'warn');
  });

  test('игра, рисующая по событию, не объявляется мёртвой', () => {
    // Пошаговая игра (Wordle-подобная) за окно замера без ввода не рисует
    // ничего — и это норма. Красный тут блокировал бы здоровую игру.
    const onDemand = { name: 'T', renderer: '2d', renderMode: 'on-demand', budgets: {} };
    const m = computeMetrics(zombie, { ...opts, seconds: 3, cfg: onDemand, pixelChange: 0 });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /on-demand/);
    assert.notEqual(m.verdict, 'fail');
  });

  test('нормальная отрисовка проходит', () => {
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}), pixelChange: 0.02 });
    assert.equal(render(m).status, 'pass');
    assert.match(render(m).detail, /100 из 100 кадров игры/);
  });

  test('рисует каждый кадр, а пиксели не двигаются — рисунок уходит в никуда', () => {
    // Потерянный blit: сцена рисуется в закадровый буфер и не переносится
    // на экран. Не провал (WebGL честно перерисовывает одинаковые кадры),
    // но и не молчание.
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}), pixelChange: 0 });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /уходит в никуда/);
  });

  test('доля, а не абсолютное число: 5 кадров из 720 — не живой рендер', () => {
    // Порог MIN_FRAMES здесь не годится: чем длиннее --seconds, тем слабее
    // становился бы гейт. Рендер, умерший на второй секунде, — обычная авария.
    const m = computeMetrics(raw({ frames: 720, gameFrames: 720, paintFrames: 5 }), {
      ...opts, seconds: 12, cfg: cfg({}), pixelChange: 0,
    });
    assert.notEqual(render(m).status, 'pass');
    assert.match(render(m).detail, /5 из 720/);
  });

  test('половина кадров с отрисовкой — уже жизнь', () => {
    const m = computeMetrics(raw({ paintFrames: 60 }), { ...opts, cfg: cfg({}), pixelChange: 0.02 });
    assert.equal(render(m).status, 'pass');
  });

  test('игра, рисующая урывками, — предупреждение', () => {
    const m = computeMetrics(raw({ paintFrames: 3 }), { ...opts, cfg: cfg({}), pixelChange: 0.02 });
    assert.equal(render(m).status, 'warn');
    assert.match(render(m).detail, /почти не перерисовывается/);
  });

  test('без кадров игры проверка молчит, а не выдумывает крутящийся цикл', () => {
    // dead-game: rAF не вызывается вовсе. «Цикл rAF крутится (0 кадров игры)» —
    // это ложь в одну строку, и её видел бы человек и агент-критик.
    const m = computeMetrics(raw({ frames: 90, gameFrames: 0, paintFrames: 0, work: Array(90).fill(0) }), {
      ...opts, seconds: 3, cfg: cfg({}), pixelChange: 0,
    });
    assert.equal(render(m), undefined, 'про отрисовку сказать нечего');
    assert.equal(m.checks.find((c) => c.name === 'sample').status, 'fail', 'красное говорит sample');
  });

  test('старый probe.json без paintFrames проверку не получает', () => {
    const legacy = { frames: 100, gameFrames: 100, workSamples: 100, frameSamples: 100, frameWorkMs: 1, frameWorkP99Ms: 2, errorCount: 0, errors: [] };
    assert.equal(evaluateBudgets(legacy, {}).find((c) => c.name === 'render'), undefined);
  });

  test('артефакт сорванного замера не выдумывает диагноз про рендер', () => {
    // Раньше abort-артефакт утверждал «игра рисует мимо 2D/WebGL» — при том,
    // что ни одного скриншота сравнено не было. Это уходило в отчёт и критику.
    const m = computeMetrics(
      { frames: 0, longFrames: 0, times: [], work: [], workTotal: 0, workMax: 0, gameFrames: 0, paintFrames: null, draws: [], drawsMax: 0, drawsTotal: 0, elapsedMs: 0, heapBytes: null, state: null },
      { ...opts, cfg: cfg({}) },
    );
    assert.equal(m.paintFrames, null);
    assert.equal(render(m), undefined);
  });
});

describe('игра, которая встаёт', () => {
  const spikes = (m) => m.checks.find((c) => c.name === 'frame-spikes');

  test('длинные кадры валят проверку, даже когда работа внутри rAF копеечная', () => {
    // Repro из ревью: тяжёлый setInterval блокирует поток, работа ВНУТРИ rAF
    // при этом 0.03 мс — и раньше всё было зелёным при 13 кадрах из 13 длинных.
    const stall = raw({ work: Array(13).fill(0.03), draws: Array(13).fill(5), frames: 13, longFrames: 13, times: Array(13).fill(300) });
    const m = computeMetrics(stall, { ...opts, seconds: 4, cfg: cfg({}) });

    assert.equal(m.frameWorkMs, 0.03, 'внутри rAF действительно пусто');
    assert.equal(m.longFrameRatio, 1);
    assert.equal(spikes(m).status, 'fail');
    assert.match(spikes(m).detail, /игра встаёт/);
    assert.equal(m.verdict, 'fail');
  });

  test('одиночный длинный кадр из сотни — не приговор', () => {
    const m = computeMetrics(raw({ longFrames: 1 }), { ...opts, cfg: cfg({}) });
    assert.equal(spikes(m).status, 'pass');
  });

  test('пятая часть длинных кадров — предупреждение', () => {
    const m = computeMetrics(raw({ longFrames: 15 }), { ...opts, cfg: cfg({}) });
    assert.equal(spikes(m).status, 'warn');
  });

  test('софтверный WebGL понижает провал до предупреждения — это среда, а не игра', () => {
    const stall = raw({ work: Array(13).fill(0.03), frames: 13, longFrames: 13, times: Array(13).fill(300) });
    const m = computeMetrics(stall, { ...opts, cfg: { name: 'T', renderer: 'webgl', budgets: {} }, headless: true });
    assert.equal(m.softwareGl, true);
    assert.equal(spikes(m).status, 'warn');
  });

  test('доля занятости названа честно: это время внутри rAF, а не весь поток', () => {
    const m = computeMetrics(raw(), { ...opts, cfg: cfg({}) });
    assert.match(m.checks.find((c) => c.name === 'frame-work').detail, /внутри rAF/);
  });
});

describe('счётчик draw calls не сработал', () => {
  test('ноль вызовов при живом рендере — провал, а не «уложились в бюджет»', () => {
    // 2D-канвас с бюджетом drawCalls: гейт, который невозможно провалить,
    // бесполезен — и молча делает вид, что GPU-нагрузка измерена.
    const m = computeMetrics(raw({ draws: Array(100).fill(0), drawsMax: 0, drawsTotal: 0 }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    const dc = m.checks.find((c) => c.name === 'draw-calls');
    assert.equal(dc.status, 'fail');
    assert.match(dc.detail, /счётчик draw call не сработал/);
  });

  test('без живого рендера про счётчик не сочиняем — там уже красный sample', () => {
    const m = computeMetrics(raw({ work: [], draws: [], drawsMax: 0, frames: 0, gameFrames: 0, times: [] }), {
      ...opts, cfg: cfg({ drawCalls: 150 }),
    });
    assert.doesNotMatch(m.checks.find((c) => c.name === 'draw-calls').detail, /не сработал/);
  });
});

describe('длительность замера', () => {
  for (const bad of [0, -1, NaN, Infinity, 'восемь']) {
    test(`seconds=${String(bad)} отвергается до запуска браузера`, async () => {
      await assert.rejects(
        () => probe({ name: 'T', dir: '/tmp/нет-такой', budgets: {} }, { seconds: bad }),
        /положительным числом/,
      );
    });
  }

  test('нормальное значение до валидации не доходит как ошибка', async () => {
    // Проверяем, что валидатор не ловит лишнего: дальше падаем уже на конфиге.
    await assert.rejects(
      () => probe({ name: 'T', dir: '/tmp/нет-такой', budgets: {}, adapterFile: '/tmp/нет-адаптера.mjs' }, { seconds: 3 }),
      /Адаптер не найден/,
    );
  });
});

describe('вьюпорт замера', () => {
  test('явный флаг важнее сценария', () => {
    assert.equal(resolveViewport('desktop', { viewport: 'phone' }, { viewport: 'portrait' }), 'desktop');
  });

  test('сценарий важнее конфига: «phone» — это и есть замеряемая сцена', () => {
    assert.equal(resolveViewport(null, { viewport: 'phone' }, { viewport: 'portrait' }), 'phone');
  });

  test('сценарий без вьюпорта не затирает конфиг', () => {
    assert.equal(resolveViewport(null, { name: 'peak' }, { viewport: 'portrait' }), 'portrait');
  });

  test('без сценария и без конфига — десктоп', () => {
    assert.equal(resolveViewport(null, null, {}), 'desktop');
  });
});

describe('подготовка сцены', () => {
  /** Страница-заглушка: expect выполняется как обычная функция, без браузера. */
  const stubPage = () => ({
    evaluated: 0,
    async evaluate(fn, arg) { this.evaluated++; return typeof fn === 'function' ? fn(arg) : true; },
    async waitForTimeout() {},
  });

  const step = (ok, msg) => ({ expect: { fn: () => ok, msg } });

  test('проверки копятся в одном массиве, а не теряются пошагово', async () => {
    const checks = await prepareScene(stubPage(), { name: 'peak', steps: [step(true, 'первая'), step(true, 'вторая')] }, {});
    assert.equal(checks.length, 2, 'раньше каждому шагу доставался свой пустой массив');
    assert.deepEqual(checks.map((c) => c.status), ['pass', 'pass']);
  });

  test('ложный expect отменяет замер и называет шаг', async () => {
    const sc = { name: 'storm-peak', steps: [step(true, 'первая'), step(false, 'шторм включён')] };
    await assert.rejects(() => prepareScene(stubPage(), sc, {}), /storm-peak.*шаг 2.*шторм включён/s);
  });

  test('после провала следующие шаги не выполняются', async () => {
    const page = stubPage();
    const sc = {
      name: 'peak',
      steps: [step(false, 'сцена собрана'), { expect: { fn: () => { throw new Error('сюда доходить нельзя'); }, msg: 'третий' } }],
    };
    await assert.rejects(() => prepareScene(page, sc, {}), /не подготовлена/);
    assert.equal(page.evaluated, 1, 'остановка на первом же провале');
  });

  test('сценарий без шагов не падает', async () => {
    const checks = await prepareScene(stubPage(), { name: 'пусто' }, {});
    assert.deepEqual(checks, []);
  });

  test('expect, вернувший не boolean, — сломанный ассерт, а не пройденный', async () => {
    // `[...document.querySelectorAll('.enemy')]` — естественная форма проверки
    // «враги заспавнены», и пустой массив истинен: сцена пуста, ассерт зелёный.
    const sc = { name: 'peak', steps: [{ expect: { fn: () => [], msg: 'враги заспавнены' } }] };
    await assert.rejects(() => prepareScene(stubPage(), sc, {}), /вернул \[\] вместо true\/false/);
  });

  test('объект вместо boolean тоже не проходит', async () => {
    const sc = { name: 'peak', steps: [{ expect: { fn: () => ({ ok: false, why: 'пусто' }), msg: 'сцена собрана' } }] };
    await assert.rejects(() => prepareScene(stubPage(), sc, {}), /вместо true\/false/);
  });
});
