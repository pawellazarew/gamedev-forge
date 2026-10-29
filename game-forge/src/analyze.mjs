import path from 'node:path';
import fs from 'node:fs';
import { readJsonl, writeJson, mean, median, percentile, wilson, color } from './util.mjs';

/** Turn raw runs into readable balance evidence: difficulty, walls, boredom and
 * skill effects. These numbers cannot establish fun; a human interprets them. */
export function analyze(simDir, opts = {}) {
  const jsonl = path.join(simDir, 'runs.jsonl');
  if (!fs.existsSync(jsonl)) throw new Error(`Missing ${jsonl}; run forge sim first`);
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

  // --- per-level entries, clears and deaths ---
  const levels = {};
  const touch = (lvl) => (levels[lvl] ||= { level: +lvl, starts: 0, clears: 0, deaths: 0, fails: 0, ticks: [], damage: {}, causes: {} });
  for (const r of runs) {
    for (const e of r.events || []) {
      if (e.type === 'level_start') touch(e.level).starts++;
      else if (e.type === 'level_clear') { const L = touch(e.level); L.clears++; if (e.ticks) L.ticks.push(e.ticks); }
      else if (e.type === 'level_fail') {
        // Only an explicit level failure counts as a failed attempt.
        const L = touch(e.level); L.fails++;
        if (e.cause) L.causes[e.cause] = (L.causes[e.cause] || 0) + 1;
      } else if (e.type === 'death') {
        // A death consumes a life, not an entire attempt. Arcade games may allow three
        // lives per level; adding deaths to clears would inflate the denominator.
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
      // An attempt starts on level entry. Without level_start, fall back to clears
      // plus explicit failures. Deaths never enter the denominator.
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

  // --- balance flags ---
  const flags = [];
  const wallAt = opts.wallAt ?? 0.25;
  const boringAt = opts.boringAt ?? 0.95;
  const spikeDelta = opts.spikeDelta ?? 0.35;

  const boring = [];
  for (const [i, L] of levelStats.entries()) {
    if (L.attempts < 5 || L.clearRate === null) continue;
    if (L.clearRate <= wallAt) {
      flags.push({ kind: 'wall', level: L.level, severity: 'high',
        detail: `clear rate ${(L.clearRate * 100).toFixed(0)}% (${L.clears}/${L.attempts}) — wall: players will get stuck`,
        hint: L.topCauses[0] ? `most common failure cause: ${L.topCauses[0][0]}` : null });
    } else if (L.clearRate >= boringAt && L.attempts >= 10) {
      boring.push(L);
    }
    const prev = levelStats[i - 1];
    if (prev?.clearRate != null && L.clearRate != null && prev.clearRate - L.clearRate >= spikeDelta) {
      flags.push({ kind: 'spike', level: L.level, severity: 'high',
        detail: `difficulty spike: ${(prev.clearRate * 100).toFixed(0)}% → ${(L.clearRate * 100).toFixed(0)}% between ${prev.level} and ${L.level}` });
    }
  }

  // Three boring levels can be listed individually. Seventeen describe a flat
  // difficulty curve and should be grouped rather than flooding the report.
  const counted = levelStats.filter((L) => L.attempts >= 10 && L.clearRate !== null);
  if (boring.length >= 3) {
    flags.push({ kind: 'flat-curve', severity: 'medium',
      detail: `${boring.length} of ${counted.length} levels have clear rate ≥${boringAt * 100}% (${boring[0].level}–${boring[boring.length - 1].level}) — difficulty does not increase`,
      hint: 'level layouts differ, but player demands do not' });
  } else {
    for (const L of boring) {
      flags.push({ kind: 'boring', level: L.level, severity: 'low',
        detail: `clear rate ${(L.clearRate * 100).toFixed(0)}% — the level creates no tension` });
    }
  }

  // If a veteran does not outperform a casual bot, skill may not matter or the bot may be broken.
  const casual = bots.find((b) => /casual|\u043d\u043e\u0432\u0438\u0447\u043e\u043a/i.test(b.bot));
  const veteran = bots.find((b) => /vet|pro|\u044d\u043a\u0441\u043f\u0435\u0440\u0442/i.test(b.bot));
  if (casual && veteran) {
    const gap = veteran.winrate - casual.winrate;
    if (gap < -0.15) {
      // Fix the bot first; otherwise balance conclusions only describe its policy quality.
      flags.push({ kind: 'bot-suspect', severity: 'high',
        detail: `veteran performs WORSE than casual: ${(veteran.winrate * 100).toFixed(0)}% versus ${(casual.winrate * 100).toFixed(0)}%`,
        hint: 'the veteran policy is broken; balance metrics are unreliable until it is fixed' });
    } else if (gap < 0.1) {
      flags.push({ kind: 'skill-flat', severity: 'medium',
        detail: `skill has little effect: casual ${(casual.winrate * 100).toFixed(0)}% vs veteran ${(veteran.winrate * 100).toFixed(0)}%`,
        hint: 'either the mechanics do not reward mastery or the bot policy does not exploit them' });
    }
    if (gap > 0.75) {
      flags.push({ kind: 'skill-cliff', severity: 'medium',
        detail: `skill cliff: casual ${(casual.winrate * 100).toFixed(0)}% vs veteran ${(veteran.winrate * 100).toFixed(0)}%`,
        hint: 'a beginner is almost certain to leave; provide a gentler introduction' });
    }
  }

  const timeoutRate = runs.length ? runs.filter((r) => r.timedOut).length / runs.length : 0;
  if (timeoutRate > 0.2) {
    flags.push({ kind: 'timeout', severity: 'medium',
      detail: `${(timeoutRate * 100).toFixed(0)}% runs hit the frame limit; the game is too long or the bot cannot finish` });
  }

  // --- progress curves: median and p10-p90 range over time ---
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
  console.log(color.b(`\n${a.game} — balance (${a.totalRuns} runs)`));
  for (const b of a.bots) {
    console.log(`  ${b.bot.padEnd(10)} winrate ${(b.winrate * 100).toFixed(0)}% ` +
      color.dim(`(${(b.winrateLo * 100).toFixed(0)}–${(b.winrateHi * 100).toFixed(0)}%)`) +
      `  median ${b.medianSeconds}s  score ${b.medianScore}  level ${b.medianLevel}`);
  }
  if (a.levels.length) {
    console.log(color.dim('  levels (clear rate):'));
    const bar = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '·');
    for (const L of a.levels) {
      if (L.clearRate === null) continue;
      console.log(`    ${String(L.level).padStart(3)} ${bar(L.clearRate)} ${(L.clearRate * 100).toFixed(0)}% ` +
        color.dim(`n=${L.attempts}${L.medianSeconds ? `, ${L.medianSeconds}s` : ''}`));
    }
  }
  if (!a.flags.length) console.log(color.ok('  no balance flags'));
  for (const f of a.flags) {
    const mark = f.severity === 'high' ? color.bad('!!') : f.severity === 'medium' ? color.warn(' !') : color.dim(' ·');
    console.log(`  ${mark} [${f.kind}]${f.level ? ` lvl.${f.level}` : ''} ${f.detail}${f.hint ? color.dim(` — ${f.hint}`) : ''}`);
  }
}
