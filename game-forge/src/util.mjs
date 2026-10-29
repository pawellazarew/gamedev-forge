import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** Parse `--key value`, `--key=value` and `--flag`; positional arguments go in `_`. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      // Support `--key=value`: otherwise --scenario=storm-peak becomes an unknown flag,
      // the scene is never prepared, and probe reports a green result for the title screen.
      const eq = body.indexOf('=');
      if (eq > 0) { out[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      const key = body;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

export function num(v, dflt) {
  // An option without a value becomes true, and Number(true) === 1.
  // Reject it here so `forge sim --runs --bot x` does not silently run once.
  if (typeof v === 'boolean' || v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function appendJsonl(file, rows) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Lexicographically sortable run stamp: 20260728-143005. */
export function runStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Run artifact directory: <gameDir>/.forge/<kind>-<stamp>/. */
export function runDir(gameDir, kind, stamp = runStamp()) {
  return ensureDir(path.join(gameDir, '.forge', `${kind}-${stamp}`));
}

/** Point .forge/latest-<kind> at the newest run so reviewers can find it. */
export function linkLatest(gameDir, kind, dir) {
  const link = path.join(gameDir, '.forge', `latest-${kind}`);
  try { fs.unlinkSync(link); } catch { /* Nothing to remove. */ }
  try { fs.symlinkSync(path.basename(dir), link, 'dir'); } catch { /* Symlinks unavailable on this filesystem; nonfatal. */ }
  return link;
}

// --- statistics ---

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Wilson confidence interval for a proportion. Without it, a noisy win rate
 * from 30 runs looks like an exact result. */
export function wilson(successes, total, z = 1.96) {
  if (!total) return { p: 0, lo: 0, hi: 0 };
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const c = p + (z * z) / (2 * total);
  const s = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { p, lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

/** Filter normal single-page-game noise: a missing favicon and its URL-less
 * console.error companion. Genuine network failures remain visible. */
export function filterNoise(errors) {
  const noisy = (e) => /favicon\.ico/.test(e.text)
    // Headless SwiftShader driver warnings describe the measurement environment,
    // not the game.
    || /GL Driver Message|GPU stall|SwiftShader|Automatic fallback to software WebGL/i.test(e.text);
  const realNetwork = errors.filter((e) => (e.kind === 'http' || e.kind === 'requestfailed') && !noisy(e));
  return errors.filter((e) => {
    if (noisy(e)) return false;
    if (e.kind === 'console.error' && /Failed to load resource/.test(e.text) && !realNetwork.length) return false;
    return true;
  });
}

export const color = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

export function verdictMark(status) {
  return status === 'pass' ? color.ok('PASS') : status === 'warn' ? color.warn('WARN') : color.bad('FAIL');
}
