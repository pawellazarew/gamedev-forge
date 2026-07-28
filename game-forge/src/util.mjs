import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** Разбор argv в стиле `--key value`, `--key=value` / `--flag`. Позиционные — в `_`. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      // Форма `--key=value` обязательна: без неё `--scenario=storm-peak`
      // превращался в неизвестный флаг «scenario=storm-peak», сцена молча
      // не готовилась, и probe мерил стартовый экран под зелёным вердиктом.
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
  // `--runs` без значения парсится во флаг `true`, а Number(true) === 1:
  // без этой проверки «forge sim --runs --bot x» молча делал бы один прогон
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

/** Метка прогона: 20260728-143005 — сортируется лексикографически. */
export function runStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Директория артефактов прогона: <gameDir>/.forge/<kind>-<stamp>/ */
export function runDir(gameDir, kind, stamp = runStamp()) {
  return ensureDir(path.join(gameDir, '.forge', `${kind}-${stamp}`));
}

/** Симлинк .forge/latest-<kind> → свежий прогон, чтобы агент всегда знал куда смотреть. */
export function linkLatest(gameDir, kind, dir) {
  const link = path.join(gameDir, '.forge', `latest-${kind}`);
  try { fs.unlinkSync(link); } catch { /* нет — и не надо */ }
  try { fs.symlinkSync(path.basename(dir), link, 'dir'); } catch { /* FS без симлинков — не критично */ }
  return link;
}

// --- статистика ---

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

/**
 * Доверительный интервал Уилсона для доли — winrate по 30 прогонам без него
 * читается как точное число, хотя это шум.
 */
export function wilson(successes, total, z = 1.96) {
  if (!total) return { p: 0, lo: 0, hi: 0 };
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const c = p + (z * z) / (2 * total);
  const s = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { p, lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

/**
 * Отсеивает шум, который есть у любой игры-одностраничника и не является
 * дефектом: отсутствующий favicon и парный к нему console.error без URL.
 * Настоящие сетевые сбои проходят фильтр насквозь.
 */
export function filterNoise(errors) {
  const noisy = (e) => /favicon\.ico/.test(e.text)
    // SwiftShader в headless сыплет предупреждениями драйвера — это про
    // окружение замера, а не про игру.
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
