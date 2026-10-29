#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, num, runStamp, readJson, color, FORGE_ROOT } from '../src/util.mjs';
import { loadConfig, loadScenarios, loadAdapter } from '../src/harness.mjs';
import { probe, printProbe } from '../src/probe.mjs';
import { runScenarios, printScenarios } from '../src/scenario.mjs';
import { simulate, printSim } from '../src/sim.mjs';
import { analyze, printAnalysis } from '../src/analyze.mjs';
import { report, printReport } from '../src/report.mjs';
import { findChromium } from '../src/browser.mjs';

const HELP = `
${color.b('forge')} — autonomous web-game development pipeline

  forge doctor                        check the environment
  forge init <gameDir>                create forge.config.mjs and templates
  forge probe <gameDir> [--seconds 8] [--viewport desktop] [--headed] [--scenario storm-peak]
  forge shots <gameDir> [--only <scenario>]
  forge play  <gameDir> [--only <scenario>]     capture scenarios and fail on failed expect checks
  forge sim   <gameDir> [--runs 60] [--bot <name>] [--max-ticks N] [--seed 1000]
  forge analyze <gameDir> [--dir .forge/latest-sim]
  forge report  <gameDir>             build HTML from the latest runs
  forge critique <gameDir>            reviewer brief (what to inspect)
  forge all   <gameDir> [--runs 40]   probe + shots + sim + analyze + report

Flags: --seed N, --viewport desktop|wide|portrait|phone|phoneLandscape|tablet, --headed
       --scenario <name> — prepare a demanding scene before measuring
       viewport: explicit --viewport → scenario viewport → config viewport
       hittable in config lists selectors players must be able to reach:
       play/shots check them at scenario end and through hittable@<viewport> sweeps
`;

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const gameDir = args._[0];

try {
  await main();
} catch (err) {
  console.error(color.bad('\n✗ ' + (err?.message || err)));
  if (process.env.FORGE_DEBUG) console.error(err);
  process.exit(1);
}

async function main() {
  switch (cmd) {
    case 'doctor': return doctor();
    case 'init': return init(need(gameDir));
    case 'probe': return cmdProbe(await cfg());
    case 'shots': return cmdScenarios(await cfg(), 'shots');
    case 'play': return cmdScenarios(await cfg(), 'play');
    case 'sim': return cmdSim(await cfg());
    case 'analyze': return cmdAnalyze(await cfg());
    case 'report': return cmdReport(await cfg());
    case 'critique': return cmdCritique(await cfg());
    case 'all': return cmdAll(await cfg());
    default:
      console.log(HELP);
      if (cmd) process.exit(1);
  }
}

function need(v) {
  if (!v) throw new Error('Specify a game directory: forge <command> <gameDir>');
  return v;
}

async function cfg() {
  return loadConfig(need(gameDir));
}

function stamp() {
  return args.stamp || runStamp();
}

/** A missing string option is null; an option supplied without a value is an
 * error. Silently accepting --viewport $VP when VP is unset can measure the
 * wrong device class or leave the scenario unprepared while still passing. */
function strFlag(name) {
  const v = args[name];
  if (v === undefined) return null;
  if (typeof v !== 'string' || v === '') throw new Error(`--${name} requires a value`);
  return v;
}

// --- commands ---

function doctor() {
  const full = findChromium({ shell: false });
  const shell = findChromium({ shell: true });
  const blender = fs.existsSync('/Applications/Blender.app/Contents/MacOS/Blender');
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
  const row = (ok, name, detail) => console.log(`  ${ok ? color.ok('✓') : color.bad('✗')} ${name.padEnd(22)} ${color.dim(detail)}`);
  console.log(color.b('\ngame-forge doctor'));
  row(!!full, 'Chromium (full)', full || 'missing; npx playwright install chromium');
  row(!!shell, 'Chromium (headless)', shell || 'missing; npx playwright install chromium');
  row(nodeOk, 'Node', process.version);
  row(blender, 'Blender', blender ? '/Applications/Blender.app' : 'missing; brew install --cask blender (needed for 3D/sprites)');
  console.log(color.dim(`\n  forge root: ${FORGE_ROOT}`));
  // Blender is optional; a browser and Node are required. doctor must fail if
  // either is missing, otherwise CI would accept an unusable environment.
  if (!(full || shell) || !nodeOk) {
    console.error(color.bad('\n  incomplete environment: browser missing or Node too old'));
    process.exitCode = 1;
  }
}

function init(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${abs}`);
  const cfgFile = path.join(abs, 'forge.config.mjs');
  if (fs.existsSync(cfgFile)) throw new Error(`${cfgFile} already exists`);
  const tplDir = path.join(FORGE_ROOT, 'templates');
  fs.writeFileSync(cfgFile, fs.readFileSync(path.join(tplDir, 'forge.config.mjs'), 'utf8'));
  fs.mkdirSync(path.join(abs, 'forge/references'), { recursive: true });
  for (const f of ['adapter.mjs', 'scenarios.mjs']) {
    const dst = path.join(abs, 'forge', f);
    if (!fs.existsSync(dst)) fs.writeFileSync(dst, fs.readFileSync(path.join(tplDir, f), 'utf8'));
  }
  console.log(color.ok(`✓ created:`));
  console.log(`  ${cfgFile}\n  ${path.join(abs, 'forge/adapter.mjs')}\n  ${path.join(abs, 'forge/scenarios.mjs')}\n  ${path.join(abs, 'forge/references/')} ${color.dim('— put reference screenshots here')}`);
  console.log(color.dim(`\n  next: implement the adapter for your game (see ${path.join(FORGE_ROOT, 'adapters/ADAPTER.md')})`));
}

async function cmdProbe(c) {
  const { metrics, dir } = await probe(c, {
    seconds: num(args.seconds, 8),
    // Pass null, not c.viewport: probe needs to know that the flag was omitted
    // so the scenario can still provide its own viewport.
    viewport: strFlag('viewport'),
    seed: num(args.seed, 1),
    headless: !args.headed,
    scenario: strFlag('scenario'),
    stamp: stamp(),
  });
  printProbe(metrics);
  console.log(color.dim(`  ${dir}`));
  if (metrics.verdict === 'fail' && args.strict) process.exit(2);
  return metrics;
}

async function cmdScenarios(c, kind) {
  const { summary, dir } = await runScenarios(c, {
    only: args.only || null,
    seed: num(args.seed, 1),
    kind,
    headless: !args.headed,
    viewport: strFlag('viewport'),
    stamp: stamp(),
  });
  printScenarios(summary);
  console.log(color.dim(`  ${dir}`));
  if (kind === 'play' && summary.status === 'fail') process.exit(2);
  return summary;
}

async function cmdSim(c) {
  const { meta, dir } = await simulate(c, {
    runs: num(args.runs, 60),
    bots: args.bot ? [args.bot] : null,
    maxTicks: num(args['max-ticks'], 60 * 60 * 10),
    sampleEvery: num(args['sample-every'], 60),
    seed0: num(args.seed, 1000),
    stamp: stamp(),
  });
  printSim(meta);
  const a = analyze(dir);
  printAnalysis(a);
  return { meta, dir, analysis: a };
}

function simDirOf(c) {
  const p = args.dir ? path.resolve(c.dir, args.dir) : path.join(c.dir, '.forge/latest-sim');
  if (!fs.existsSync(p)) throw new Error(`No simulation runs (${p}); run forge sim first`);
  return fs.realpathSync(p);
}

function cmdAnalyze(c) {
  const a = analyze(simDirOf(c));
  printAnalysis(a);
  return a;
}

function latest(c, kind) {
  const p = path.join(c.dir, '.forge', `latest-${kind}`);
  return fs.existsSync(p) ? fs.realpathSync(p) : null;
}

/** Latest scenario summary: play takes precedence over shots only when newer. */
function latestScenarios(c) {
  const candidates = [['play', 'play.json'], ['shots', 'shots.json']]
    .map(([kind, file]) => {
      const dir = latest(c, kind);
      const f = dir && path.join(dir, file);
      return f && fs.existsSync(f) ? { file: f, mtime: fs.statSync(f).mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? readJson(candidates[0].file) : null;
}

function shotsFrom(summary) {
  if (!summary) return [];
  return summary.scenarios.flatMap((s) => s.shots.map((sh) => ({ ...sh, scenario: s.scenario, note: sh.note || s.note })));
}

/** @param {object} [fresh] Current run results, used directly by all.
 * Otherwise reports could combine yesterday's passing play with today's
 * failing shots and hide the current regression. */
function cmdReport(c, fresh = null) {
  // With explicit results, null means the stage did not run, not a request to
  // search latest-*. Otherwise a disabled adapter could pull in an old failed
  // simulation while the current run still exits successfully.
  const fromDisk = (kind, file) => {
    const dir = latest(c, kind);
    const f = dir && path.join(dir, file);
    return f && fs.existsSync(f) ? readJson(f) : null;
  };
  const scenarios = fresh ? fresh.scenarios ?? null : latestScenarios(c);
  const file = report(c, {
    scenarios,
    probe: fresh ? fresh.probe ?? null : fromDisk('probe', 'probe.json'),
    analysis: fresh ? fresh.analysis ?? null : fromDisk('sim', 'analysis.json'),
    shots: shotsFrom(scenarios),
    stamp: stamp(),
  });
  printReport(file);
  return file;
}

function collectShots(c) {
  return shotsFrom(latestScenarios(c));
}

/** Reviewer brief: a precise inspection list rather than an assessment. */
async function cmdCritique(c) {
  const shots = collectShots(c);
  const probeDir = latest(c, 'probe');
  const simDir = latest(c, 'sim');
  const p = probeDir && fs.existsSync(path.join(probeDir, 'probe.json')) ? readJson(path.join(probeDir, 'probe.json')) : null;
  const a = simDir && fs.existsSync(path.join(simDir, 'analysis.json')) ? readJson(path.join(simDir, 'analysis.json')) : null;
  const refs = fs.existsSync(c.referencesDir) ? fs.readdirSync(c.referencesDir).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)) : [];

  const brief = {
    game: c.name,
    shots: shots.map((s) => ({ file: s.file, label: s.label, note: s.note, scenario: s.scenario })),
    references: refs.map((f) => path.join(c.referencesDir, f)),
    technical: p ? { fpsAvg: p.fpsAvg, fps1pctLow: p.fps1pctLow, errorCount: p.errorCount, bundleKb: p.bundleKb, checks: p.checks } : null,
    balance: a ? { verdict: a.verdict, bots: a.bots, flags: a.flags } : null,
    instructions: [
      'Open every screenshot in shots[] with an image-capable tool and inspect it.',
      'Compare against references[] when available; otherwise use genre standards.',
      'For each finding: screenshot, issue, player impact and a concrete code change.',
      'Report only necessary changes, at most 7 items ranked by player impact.',
      'Use existing technical measurements as context rather than restating them.',
    ],
  };
  const out = path.join(c.dir, '.forge', 'critique.json');
  fs.writeFileSync(out, JSON.stringify(brief, null, 2));
  console.log(JSON.stringify(brief, null, 2));
  console.error(color.dim(`\n(brief also saved to: ${out})`));
  return brief;
}

async function cmdAll(c) {
  const s = stamp();
  args.stamp = s;
  const scenarioDefs = await loadScenarios(c);
  const adapter = c.adapterFile ? await loadAdapter(c) : null;

  const metrics = await cmdProbe(c);
  // Hit-test sweeps are scenarios too. Without this, all skips hit testing
  // for games that have no custom scenarios.
  const scenarios = scenarioDefs.length || c.hittable ? await cmdScenarios(c, 'shots') : null;

  let analysis = null;
  if (adapter) {
    args.runs = args.runs ?? 40;
    ({ analysis } = await cmdSim(c));
  } else {
    console.log(color.dim('\n  sim skipped: no adapter configured'));
  }

  // Build the report from this run, not latest-*.
  cmdReport(c, { probe: metrics, scenarios, analysis });

  // A failed report with a zero exit code misleads both CI and autonomous agents.
  const failed = [
    metrics?.verdict === 'fail' && 'probe',
    scenarios?.status === 'fail' && 'scenarios',
    analysis?.verdict === 'needs-work' && 'balance',
  ].filter(Boolean);

  if (failed.length) {
    console.error(color.bad(`\n✗ run failed: ${failed.join(', ')}`));
    process.exitCode = 2;
  } else {
    console.log(color.ok('\n✓ run passed'));
  }
}
