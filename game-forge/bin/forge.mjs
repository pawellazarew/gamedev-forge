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
${color.b('forge')} — конвейер автономной разработки веб-игр

  forge doctor                        проверить окружение
  forge init <gameDir>                создать forge.config.mjs и заготовки
  forge probe <gameDir> [--seconds 8] [--viewport desktop] [--headed]
  forge shots <gameDir> [--only <сценарий>]
  forge play  <gameDir> [--only <сценарий>]     то же + падает на непройденных expect
  forge sim   <gameDir> [--runs 60] [--bot <имя>] [--max-ticks N] [--seed 1000]
  forge analyze <gameDir> [--dir .forge/latest-sim]
  forge report  <gameDir>             собрать HTML из последних прогонов
  forge critique <gameDir>            бриф для агента-критика (что смотреть)
  forge all   <gameDir> [--runs 40]   probe + shots + sim + analyze + report

Флаги: --seed N, --viewport desktop|wide|portrait|phone|phoneLandscape|tablet, --headed
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
  if (!v) throw new Error('Укажи папку игры: forge <команда> <gameDir>');
  return v;
}

async function cfg() {
  return loadConfig(need(gameDir));
}

function stamp() {
  return args.stamp || runStamp();
}

// --- команды ---

function doctor() {
  const full = findChromium({ shell: false });
  const shell = findChromium({ shell: true });
  const blender = fs.existsSync('/Applications/Blender.app/Contents/MacOS/Blender');
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
  const row = (ok, name, detail) => console.log(`  ${ok ? color.ok('✓') : color.bad('✗')} ${name.padEnd(22)} ${color.dim(detail)}`);
  console.log(color.b('\ngame-forge doctor'));
  row(!!full, 'Chromium (полный)', full || 'нет — npx playwright install chromium');
  row(!!shell, 'Chromium (headless)', shell || 'нет — npx playwright install chromium');
  row(nodeOk, 'Node', process.version);
  row(blender, 'Blender', blender ? '/Applications/Blender.app' : 'нет — brew install --cask blender (нужен для 3D/спрайтов)');
  console.log(color.dim(`\n  forge root: ${FORGE_ROOT}`));
  // Blender нужен не всем, а браузер и Node — обязательны: без них падать
  // должен сам doctor, иначе CI посчитает окружение исправным.
  if (!(full || shell) || !nodeOk) {
    console.error(color.bad('\n  окружение неполное: нет браузера или слишком старый Node'));
    process.exitCode = 1;
  }
}

function init(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`Нет папки ${abs}`);
  const cfgFile = path.join(abs, 'forge.config.mjs');
  if (fs.existsSync(cfgFile)) throw new Error(`${cfgFile} уже есть`);
  const tplDir = path.join(FORGE_ROOT, 'templates');
  fs.writeFileSync(cfgFile, fs.readFileSync(path.join(tplDir, 'forge.config.mjs'), 'utf8'));
  fs.mkdirSync(path.join(abs, 'forge/references'), { recursive: true });
  for (const f of ['adapter.mjs', 'scenarios.mjs']) {
    const dst = path.join(abs, 'forge', f);
    if (!fs.existsSync(dst)) fs.writeFileSync(dst, fs.readFileSync(path.join(tplDir, f), 'utf8'));
  }
  console.log(color.ok(`✓ создано:`));
  console.log(`  ${cfgFile}\n  ${path.join(abs, 'forge/adapter.mjs')}\n  ${path.join(abs, 'forge/scenarios.mjs')}\n  ${path.join(abs, 'forge/references/')} ${color.dim('— клади сюда эталонные кадры')}`);
  console.log(color.dim(`\n  дальше: заполни адаптер под свою игру (см. ${path.join(FORGE_ROOT, 'adapters/ADAPTER.md')})`));
}

async function cmdProbe(c) {
  const { metrics, dir } = await probe(c, {
    seconds: num(args.seconds, 8),
    viewport: args.viewport || c.viewport,
    seed: num(args.seed, 1),
    headless: !args.headed,
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
  if (!fs.existsSync(p)) throw new Error(`Нет прогонов симуляции (${p}) — сначала forge sim`);
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

function collectShots(c) {
  const dir = latest(c, 'shots') || latest(c, 'play');
  if (!dir) return [];
  const file = path.join(dir, 'shots.json');
  const alt = path.join(dir, 'play.json');
  const src = fs.existsSync(file) ? file : fs.existsSync(alt) ? alt : null;
  if (!src) return [];
  return readJson(src).scenarios.flatMap((s) => s.shots.map((sh) => ({ ...sh, scenario: s.scenario, note: sh.note || s.note })));
}

function cmdReport(c) {
  const probeDir = latest(c, 'probe');
  const simDir = latest(c, 'sim');
  const scDir = latest(c, 'play') || latest(c, 'shots');
  const scFile = scDir && ['play.json', 'shots.json'].map((f) => path.join(scDir, f)).find((f) => fs.existsSync(f));
  const file = report(c, {
    scenarios: scFile ? readJson(scFile) : null,
    probe: probeDir && fs.existsSync(path.join(probeDir, 'probe.json')) ? readJson(path.join(probeDir, 'probe.json')) : null,
    analysis: simDir && fs.existsSync(path.join(simDir, 'analysis.json')) ? readJson(path.join(simDir, 'analysis.json')) : null,
    shots: collectShots(c),
    stamp: stamp(),
  });
  printReport(file);
  return file;
}

/** Бриф для агента-критика: не оценка, а точный список того, что смотреть. */
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
      'Открой каждый кадр из shots[] инструментом Read — это изображения, их видно.',
      'Сравни с references[] если они есть; если нет — суди по стандартам жанра.',
      'Для каждой находки: кадр, что не так, почему это вредит игроку, конкретная правка в коде.',
      'Не хвали. Пиши только то, что надо изменить, максимум 7 пунктов, отсортированных по вреду.',
      'Технические числа не пересказывай — они уже измерены, используй их как контекст.',
    ],
  };
  const out = path.join(c.dir, '.forge', 'critique.json');
  fs.writeFileSync(out, JSON.stringify(brief, null, 2));
  console.log(JSON.stringify(brief, null, 2));
  console.error(color.dim(`\n(бриф также сохранён: ${out})`));
  return brief;
}

async function cmdAll(c) {
  const s = stamp();
  args.stamp = s;
  const scenarios = await loadScenarios(c);
  const adapter = c.adapterFile ? await loadAdapter(c) : null;

  await cmdProbe(c);
  if (scenarios.length) await cmdScenarios(c, 'shots');
  if (adapter) {
    args.runs = args.runs ?? 40;
    await cmdSim(c);
  } else {
    console.log(color.dim('\n  sim пропущен: адаптер не подключён'));
  }
  cmdReport(c);
}
