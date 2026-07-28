import path from 'node:path';
import fs from 'node:fs';
import { readJsonl, writeJson, mean, median, percentile, wilson, color } from './util.mjs';

/**
 * Превращает сырые прогоны в читаемый баланс: кривая сложности, стены, скука,
 * влияние навыка. Ни одна из этих цифр не говорит «весело ли» — она говорит
 * «где игрок застрянет и где заскучает», а решение принимает человек.
 */
export function analyze(simDir, opts = {}) {
  const jsonl = path.join(simDir, 'runs.jsonl');
  if (!fs.existsSync(jsonl)) throw new Error(`Нет ${jsonl} — сначала прогони forge sim`);
  const runs = readJsonl(jsonl);
  const meta = JSON.parse(fs.readFileSync(path.join(simDir, 'sim.json'), 'utf8'));

  const byBot = {};
  for (const r of runs) (byBot[r.bot] ||= []).push(r);

  const bots = Object.entries(byBot).map(([bot, rs]) => {
    const wins = rs.filter((r) => r.final?.win).length;
    const w = wilson(wins, rs.length);
    const durations = rs.map((r) => r.seconds);
    const scores = rs.map((r) => r.final?.score ?? 0);
    return {
      bot,
      runs: rs.length,
      winrate: +w.p.toFixed(3),
      winrateLo: +w.lo.toFixed(3),
      winrateHi: +w.hi.toFixed(3),
      timeouts: rs.filter((r) => r.timedOut).length,
      medianSeconds: +median(durations).toFixed(1),
      p10Seconds: +percentile(durations, 10).toFixed(1),
      p90Seconds: +percentile(durations, 90).toFixed(1),
      medianScore: Math.round(median(scores)),
      maxLevel: Math.max(...rs.map((r) => r.final?.level ?? 0)),
      medianLevel: median(rs.map((r) => r.final?.level ?? 0)),
    };
  });

  // --- по уровням: сколько раз входили, сколько прошли, где умирали ---
  const levels = {};
  const touch = (lvl) => (levels[lvl] ||= { level: +lvl, starts: 0, clears: 0, deaths: 0, fails: 0, ticks: [], damage: {}, causes: {} });
  for (const r of runs) {
    for (const e of r.events || []) {
      if (e.type === 'level_start') touch(e.level).starts++;
      else if (e.type === 'level_clear') { const L = touch(e.level); L.clears++; if (e.ticks) L.ticks.push(e.ticks); }
      else if (e.type === 'level_fail') {
        // Явный провал уровня — единственное, что считается неудачной попыткой
        const L = touch(e.level); L.fails++;
        if (e.cause) L.causes[e.cause] = (L.causes[e.cause] || 0) + 1;
      } else if (e.type === 'death') {
        // Смерть — это потеря жизни, а не конец попытки: в аркаде их три за
        // уровень, и складывать их с прохождениями значит завышать знаменатель
        const L = touch(e.level); L.deaths++;
        if (e.cause) L.causes[e.cause] = (L.causes[e.cause] || 0) + 1;
      } else if (e.type === 'damage') {
        const L = touch(e.level);
        L.damage[e.source || 'unknown'] = (L.damage[e.source || 'unknown'] || 0) + (e.value || 1);
      }
    }
  }

  const levelStats = Object.values(levels)
    .sort((a, b) => a.level - b.level)
    .map((L) => {
      // Попытка = вход на уровень. Если адаптер не шлёт level_start, падаем
      // на прохождения + явные провалы; смерти в знаменатель не идут никогда.
      const attempts = L.starts || (L.clears + L.fails);
      const w = wilson(L.clears, attempts);
      return {
        level: L.level,
        attempts,
        clears: L.clears,
        fails: L.fails,
        deaths: L.deaths,
        clearRate: attempts ? +w.p.toFixed(3) : null,
        clearRateLo: attempts ? +w.lo.toFixed(3) : null,
        clearRateHi: attempts ? +w.hi.toFixed(3) : null,
        medianTicks: L.ticks.length ? Math.round(median(L.ticks)) : null,
        medianSeconds: L.ticks.length ? +(median(L.ticks) / (meta.tickRate ?? 60)).toFixed(1) : null,
        topDamage: Object.entries(L.damage).sort((a, b) => b[1] - a[1]).slice(0, 5),
        topCauses: Object.entries(L.causes).sort((a, b) => b[1] - a[1]).slice(0, 5),
      };
    });

  // --- флаги: то, ради чего всё и затевалось ---
  const flags = [];
  const wallAt = opts.wallAt ?? 0.25;
  const boringAt = opts.boringAt ?? 0.95;
  const spikeDelta = opts.spikeDelta ?? 0.35;

  const boring = [];
  for (const [i, L] of levelStats.entries()) {
    if (L.attempts < 5 || L.clearRate === null) continue;
    if (L.clearRate <= wallAt) {
      flags.push({ kind: 'wall', level: L.level, severity: 'high',
        detail: `проходимость ${(L.clearRate * 100).toFixed(0)}% (${L.clears}/${L.attempts}) — стена, игрок упрётся`,
        hint: L.topCauses[0] ? `чаще всего конец от: ${L.topCauses[0][0]}` : null });
    } else if (L.clearRate >= boringAt && L.attempts >= 10) {
      boring.push(L);
    }
    const prev = levelStats[i - 1];
    if (prev?.clearRate != null && L.clearRate != null && prev.clearRate - L.clearRate >= spikeDelta) {
      flags.push({ kind: 'spike', level: L.level, severity: 'high',
        detail: `скачок сложности: ${(prev.clearRate * 100).toFixed(0)}% → ${(L.clearRate * 100).toFixed(0)}% между ${prev.level} и ${L.level}` });
    }
  }

  // Три отдельных «скучно» — это три уровня. Семнадцать — это уже диагноз всей
  // кривой, и списком по одному он не читается.
  const counted = levelStats.filter((L) => L.attempts >= 10 && L.clearRate !== null);
  if (boring.length >= 3) {
    flags.push({ kind: 'flat-curve', severity: 'medium',
      detail: `${boring.length} из ${counted.length} уровней проходятся с вероятностью ≥${boringAt * 100}% (${boring[0].level}–${boring[boring.length - 1].level}) — сложность не растёт`,
      hint: 'уровни отличаются рисунком, но не требованиями к игроку' });
  } else {
    for (const L of boring) {
      flags.push({ kind: 'boring', level: L.level, severity: 'low',
        detail: `проходимость ${(L.clearRate * 100).toFixed(0)}% — уровень не создаёт напряжения` });
    }
  }

  // Если ветеран играет не лучше казуала — либо навык не решает, либо бот тупой.
  const casual = bots.find((b) => /casual|новичок/i.test(b.bot));
  const veteran = bots.find((b) => /vet|pro|эксперт/i.test(b.bot));
  if (casual && veteran) {
    const gap = veteran.winrate - casual.winrate;
    if (gap < -0.15) {
      // Сначала чиним бота. Иначе все выводы о балансе будут о качестве политики.
      flags.push({ kind: 'bot-suspect', severity: 'high',
        detail: `veteran играет ХУЖЕ казуала: ${(veteran.winrate * 100).toFixed(0)}% против ${(casual.winrate * 100).toFixed(0)}%`,
        hint: 'политика ветерана сломана — до её починки цифры баланса недостоверны' });
    } else if (gap < 0.1) {
      flags.push({ kind: 'skill-flat', severity: 'medium',
        detail: `навык почти не влияет: casual ${(casual.winrate * 100).toFixed(0)}% vs veteran ${(veteran.winrate * 100).toFixed(0)}%`,
        hint: 'либо механика не награждает мастерство, либо политика бота не использует её' });
    }
    if (gap > 0.75) {
      flags.push({ kind: 'skill-cliff', severity: 'medium',
        detail: `пропасть по навыку: casual ${(casual.winrate * 100).toFixed(0)}% vs veteran ${(veteran.winrate * 100).toFixed(0)}%`,
        hint: 'новичок почти гарантированно уходит — нужен более пологий вход' });
    }
  }

  const timeoutRate = runs.length ? runs.filter((r) => r.timedOut).length / runs.length : 0;
  if (timeoutRate > 0.2) {
    flags.push({ kind: 'timeout', severity: 'medium',
      detail: `${(timeoutRate * 100).toFixed(0)}% прогонов уперлись в лимит кадров — партия слишком длинная или бот не может закончить` });
  }

  // --- кривые прогресса: медиана и коридор p10–p90 по времени ---
  const curveKeys = opts.curveKeys || autoCurveKeys(runs);
  const progress = buildProgress(runs, curveKeys, meta.tickRate ?? 60);

  const analysis = {
    game: meta.game,
    generatedFrom: simDir,
    totalRuns: runs.length,
    bots,
    levels: levelStats,
    flags,
    progress,
    verdict: flags.some((f) => f.severity === 'high') ? 'needs-work'
      : flags.length ? 'watch' : 'ok',
  };
  writeJson(path.join(simDir, 'analysis.json'), analysis);
  return analysis;
}

function autoCurveKeys(runs) {
  const s = runs.find((r) => r.samples?.length)?.samples?.[0];
  if (!s) return [];
  return Object.keys(s).filter((k) => k !== 't' && typeof s[k] === 'number').slice(0, 6);
}

function buildProgress(runs, keys, tickRate = 60) {
  if (!keys.length) return [];
  const byT = new Map();
  for (const r of runs) {
    for (const s of r.samples || []) {
      const bucket = byT.get(s.t) || (byT.set(s.t, {}), byT.get(s.t));
      for (const k of keys) {
        if (typeof s[k] === 'number') (bucket[k] ||= []).push(s[k]);
      }
    }
  }
  return [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, vals]) => {
      const row = { t, seconds: +(t / (tickRate || 60)).toFixed(1) };
      for (const k of keys) {
        const xs = vals[k] || [];
        row[k] = { med: +median(xs).toFixed(2), p10: +percentile(xs, 10).toFixed(2), p90: +percentile(xs, 90).toFixed(2), n: xs.length };
      }
      return row;
    });
}

export function printAnalysis(a) {
  console.log(color.b(`\n${a.game} — баланс (${a.totalRuns} прогонов)`));
  for (const b of a.bots) {
    console.log(`  ${b.bot.padEnd(10)} winrate ${(b.winrate * 100).toFixed(0)}% ` +
      color.dim(`(${(b.winrateLo * 100).toFixed(0)}–${(b.winrateHi * 100).toFixed(0)}%)`) +
      `  медиана ${b.medianSeconds}с  очки ${b.medianScore}  уровень ${b.medianLevel}`);
  }
  if (a.levels.length) {
    console.log(color.dim('  уровни (проходимость):'));
    const bar = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '·');
    for (const L of a.levels) {
      if (L.clearRate === null) continue;
      console.log(`    ${String(L.level).padStart(3)} ${bar(L.clearRate)} ${(L.clearRate * 100).toFixed(0)}% ` +
        color.dim(`n=${L.attempts}${L.medianSeconds ? `, ${L.medianSeconds}с` : ''}`));
    }
  }
  if (!a.flags.length) console.log(color.ok('  флагов баланса нет'));
  for (const f of a.flags) {
    const mark = f.severity === 'high' ? color.bad('!!') : f.severity === 'medium' ? color.warn(' !') : color.dim(' ·');
    console.log(`  ${mark} [${f.kind}]${f.level ? ` ур.${f.level}` : ''} ${f.detail}${f.hint ? color.dim(` — ${f.hint}`) : ''}`);
  }
}
