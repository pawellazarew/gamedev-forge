import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyze.mjs';

/** Готовит каталог с runs.jsonl + sim.json, как после настоящего forge sim. */
function fakeSim(runs, meta = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-analyze-'));
  fs.writeFileSync(path.join(dir, 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(dir, 'sim.json'), JSON.stringify({ game: 'test', tickRate: 60, ...meta }));
  return dir;
}

const run = (bot, { events = [], final = {}, ticks = 1000, samples = [] } = {}) => ({
  bot, ticks, seconds: ticks / 60, timedOut: false,
  final: { over: true, win: false, score: 0, level: 1, ...final },
  events, samples,
});

describe('знаменатель проходимости', () => {
  test('потери жизней НЕ считаются попытками уровня', () => {
    // Уровень пройден с четырьмя потерянными мячами: это 1/1, а не 1/5
    const events = [
      { t: 0, type: 'level_start', level: 1 },
      ...Array.from({ length: 4 }, (_, i) => ({ t: i + 1, type: 'death', level: 1, cause: 'ball_lost' })),
      { t: 100, type: 'level_clear', level: 1, ticks: 100 },
    ];
    const a = analyze(fakeSim(Array.from({ length: 10 }, () => run('casual', { events }))));
    const L = a.levels.find((x) => x.level === 1);
    assert.equal(L.attempts, 10);
    assert.equal(L.clears, 10);
    assert.equal(L.clearRate, 1, 'смерти раздували знаменатель и занижали проходимость');
    assert.equal(L.deaths, 40, 'но сами смерти учитываются отдельно');
  });

  test('level_fail — вот это настоящая неудачная попытка', () => {
    const cleared = { events: [{ t: 0, type: 'level_start', level: 2 }, { t: 9, type: 'level_clear', level: 2, ticks: 9 }] };
    const failed = { events: [{ t: 0, type: 'level_start', level: 2 }, { t: 9, type: 'level_fail', level: 2, cause: 'timeout' }] };
    const runs = [...Array.from({ length: 6 }, () => run('a', cleared)), ...Array.from({ length: 4 }, () => run('a', failed))];
    const L = analyze(fakeSim(runs)).levels.find((x) => x.level === 2);
    assert.equal(L.attempts, 10);
    assert.equal(L.clearRate, 0.6);
    assert.equal(L.fails, 4);
  });

  test('без level_start знаменатель собирается из clear + fail', () => {
    const runs = [
      run('a', { events: [{ t: 1, type: 'level_clear', level: 3, ticks: 5 }] }),
      run('a', { events: [{ t: 1, type: 'level_fail', level: 3 }] }),
    ];
    const L = analyze(fakeSim(runs)).levels.find((x) => x.level === 3);
    assert.equal(L.attempts, 2);
    assert.equal(L.clearRate, 0.5);
  });
});

describe('флаги баланса', () => {
  const levelRuns = (level, clearRatio, n = 20) => Array.from({ length: n }, (_, i) => run('bot', {
    events: [
      { t: 0, type: 'level_start', level },
      i < Math.round(n * clearRatio)
        ? { t: 10, type: 'level_clear', level, ticks: 600 }
        : { t: 10, type: 'level_fail', level, cause: 'died' },
    ],
  }));

  test('wall на низкой проходимости', () => {
    const a = analyze(fakeSim(levelRuns(5, 0.1)));
    const f = a.flags.find((x) => x.kind === 'wall');
    assert.ok(f, 'проходимость 10% обязана поднять флаг');
    assert.equal(f.severity, 'high');
    assert.equal(a.verdict, 'needs-work');
  });

  test('spike при обвале между соседними уровнями', () => {
    const a = analyze(fakeSim([...levelRuns(1, 1.0), ...levelRuns(2, 0.3)]));
    assert.ok(a.flags.some((x) => x.kind === 'spike' && x.level === 2));
  });

  test('flat-curve вместо трёх и более отдельных «скучно»', () => {
    const a = analyze(fakeSim([1, 2, 3, 4].flatMap((l) => levelRuns(l, 1.0))));
    assert.ok(a.flags.some((x) => x.kind === 'flat-curve'));
    assert.equal(a.flags.filter((x) => x.kind === 'boring').length, 0, 'иначе отчёт тонет в повторах');
  });

  test('bot-suspect: ветеран хуже казуала — сначала чинить бота', () => {
    const runs = [
      ...Array.from({ length: 10 }, () => run('casual', { final: { win: true } })),
      ...Array.from({ length: 10 }, () => run('veteran', { final: { win: false } })),
    ];
    const a = analyze(fakeSim(runs));
    const f = a.flags.find((x) => x.kind === 'bot-suspect');
    assert.ok(f);
    assert.equal(f.severity, 'high');
    assert.ok(!a.flags.some((x) => x.kind === 'skill-flat'), 'это не «навык не влияет», это сломанный бот');
  });

  test('skill-flat, когда навык действительно ничего не меняет', () => {
    const runs = [
      ...Array.from({ length: 10 }, () => run('casual', { final: { win: true } })),
      ...Array.from({ length: 10 }, () => run('veteran', { final: { win: true } })),
    ];
    const a = analyze(fakeSim(runs));
    assert.ok(a.flags.some((x) => x.kind === 'skill-flat'));
  });

  test('timeout при массовом упоре в лимит кадров', () => {
    const runs = Array.from({ length: 10 }, () => ({ ...run('a'), timedOut: true }));
    assert.ok(analyze(fakeSim(runs)).flags.some((x) => x.kind === 'timeout'));
  });

  test('чистый прогон не выдумывает флагов', () => {
    const runs = [
      ...Array.from({ length: 20 }, (_, i) => run('casual', { final: { win: i < 12 } })),
      ...Array.from({ length: 20 }, (_, i) => run('veteran', { final: { win: i < 18 } })),
    ];
    const a = analyze(fakeSim(runs));
    assert.deepEqual(a.flags.map((f) => f.kind), []);
    assert.equal(a.verdict, 'ok');
  });
});

describe('tickRate', () => {
  test('секунды считаются по частоте тика адаптера, а не по 60', () => {
    const events = [{ t: 0, type: 'level_start', level: 1 }, { t: 3600, type: 'level_clear', level: 1, ticks: 3600 }];
    const idle = analyze(fakeSim([run('a', { events }), run('a', { events })], { tickRate: 1 }));
    assert.equal(idle.levels[0].medianSeconds, 3600, 'idle-тик = секунда: час игры');

    const arcade = analyze(fakeSim([run('a', { events }), run('a', { events })], { tickRate: 60 }));
    assert.equal(arcade.levels[0].medianSeconds, 60, 'кадр = 1/60 c: минута игры');
  });
});

describe('winrate по ботам', () => {
  test('интервал Уилсона попадает в отчёт', () => {
    const runs = Array.from({ length: 10 }, (_, i) => run('casual', { final: { win: i < 6 } }));
    const b = analyze(fakeSim(runs)).bots[0];
    assert.equal(b.winrate, 0.6);
    assert.ok(b.winrateLo < 0.6 && b.winrateHi > 0.6);
    assert.equal(b.runs, 10);
  });
});
