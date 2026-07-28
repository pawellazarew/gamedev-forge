import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, runDir, linkLatest, color } from './util.mjs';

/**
 * Один HTML без внешних зависимостей: графики рисуем SVG-строками.
 * Смысл отчёта — чтобы человек за 30 секунд увидел то, на что агенту
 * потребовалось бы 300 строк описания.
 */
/** Худший статус побеждает: зелёный отчёт при красном probe — ложь. */
export function combineVerdict({ probe, analysis, scenarios }) {
  const rank = { fail: 3, 'needs-work': 3, warn: 2, watch: 2, pass: 1, ok: 1 };
  const parts = [probe?.verdict, analysis?.verdict, scenarios?.status].filter(Boolean);
  if (!parts.length) return 'ok';
  return parts.reduce((worst, v) => ((rank[v] ?? 0) > (rank[worst] ?? 0) ? v : worst), parts[0]);
}

export function report(cfg, { probe = null, analysis = null, shots = [], scenarios = null, stamp } = {}) {
  const dir = runDir(cfg.dir, 'report', stamp);
  const html = renderHtml(cfg, { probe, analysis, shots, scenarios, dir });
  const file = path.join(dir, 'index.html');
  ensureDir(dir);
  fs.writeFileSync(file, html);
  linkLatest(cfg.dir, 'report', dir);
  return file;
}

function renderHtml(cfg, { probe, analysis, shots, scenarios, dir }) {
  const verdict = combineVerdict({ probe, analysis, scenarios });
  const badge = { ok: ['#2ea043', 'В норме'], pass: ['#2ea043', 'В норме'], watch: ['#d29922', 'Под наблюдением'],
    warn: ['#d29922', 'Под наблюдением'], 'needs-work': ['#f85149', 'Требует правок'], fail: ['#f85149', 'Требует правок'] }[verdict] || ['#8b949e', verdict];

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.name)} — отчёт game-forge</title>
<style>
  :root { color-scheme: dark light; --bg:#0d1117; --fg:#e6edf3; --dim:#8b949e; --card:#161b22; --line:#30363d; --acc:#58a6ff; }
  @media (prefers-color-scheme: light) { :root { --bg:#fff; --fg:#1f2328; --dim:#656d76; --card:#f6f8fa; --line:#d0d7de; --acc:#0969da; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:24px; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:28px 0 10px; border-bottom:1px solid var(--line); padding-bottom:6px; }
  .sub { color:var(--dim); margin-bottom:18px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:20px; color:#fff; font-weight:600; font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; }
  .card .k { color:var(--dim); font-size:12px; } .card .v { font-size:20px; font-weight:600; margin-top:2px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-weight:500; }
  .flag { border-left:3px solid; padding:8px 12px; margin:6px 0; background:var(--card); border-radius:0 6px 6px 0; }
  .high { border-color:#f85149; } .medium { border-color:#d29922; } .low { border-color:#8b949e; }
  .shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px; }
  .shot img { width:100%; border:1px solid var(--line); border-radius:6px; background:#000; }
  .shot .cap { color:var(--dim); font-size:12px; margin-top:4px; }
  .ok { color:#2ea043; } .warn { color:#d29922; } .bad { color:#f85149; }
  svg { max-width:100%; height:auto; overflow:visible; }
  code { background:var(--card); padding:1px 5px; border-radius:4px; font-size:12px; }
</style></head><body><div class="wrap">
<h1>${esc(cfg.name)} <span class="badge" style="background:${badge[0]}">${badge[1]}</span></h1>
<div class="sub">game-forge · ${new Date().toLocaleString('ru-RU')}</div>

${probe ? probeSection(probe) : ''}
${scenarios ? scenariosSection(scenarios) : ''}
${analysis ? botsSection(analysis) : ''}
${analysis?.levels?.length ? difficultySection(analysis) : ''}
${analysis?.progress?.length ? progressSection(analysis) : ''}
${analysis?.flags?.length ? flagsSection(analysis) : ''}
${shots.length ? shotsSection(shots, dir) : ''}
</div></body></html>`;
}

function probeSection(p) {
  const cls = (s) => (s === 'pass' ? 'ok' : s === 'warn' ? 'warn' : 'bad');
  return `<h2>Техника</h2>
<div class="grid">
  <div class="card"><div class="k">Работа в кадре</div><div class="v">${p.frameWorkMs ?? '—'} мс <span style="font-size:14px;color:var(--dim)">запас ×${p.headroom ?? '—'}</span></div></div>
  <div class="card"><div class="k">p99 / максимум</div><div class="v">${p.frameWorkP99Ms ?? '—'} <span style="font-size:14px;color:var(--dim)">/ ${p.frameWorkMaxMs ?? '—'} мс</span></div></div>
  <div class="card"><div class="k">Занято внутри rAF</div><div class="v">${p.mainThreadBusy != null ? Math.round(p.mainThreadBusy * 100) + '%' : '—'}</div></div>
  <div class="card"><div class="k">Ошибок в консоли</div><div class="v ${p.errorCount ? 'bad' : 'ok'}">${p.errorCount}</div></div>
  <div class="card"><div class="k">Вес загруженного</div><div class="v">${p.bundleKb} КБ</div></div>
  <div class="card"><div class="k">Загрузка</div><div class="v">${p.loadMs} мс</div></div>
  <div class="card"><div class="k">Draw calls (p99 / макс)</div><div class="v">${p.drawCallsP99 ?? '—'} <span style="font-size:14px;color:var(--dim)">/ ${p.drawCallsMax ?? '—'}</span></div></div>
</div>
<table><tbody>
${p.checks.map((c) => `<tr><td class="${cls(c.status)}">${c.status.toUpperCase()}</td><td><b>${esc(c.name)}</b></td><td>${esc(c.detail)}</td></tr>`).join('')}
</tbody></table>
${p.errorCount ? `<details><summary>Ошибки (${p.errorCount})</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(p.errors.slice(0, 30).map((e) => `${e.kind}: ${e.text}`).join('\n'))}</pre></details>` : ''}`;
}

function scenariosSection(sc) {
  const cls = (s) => (s === 'pass' ? 'ok' : s === 'warn' ? 'warn' : 'bad');
  return `<h2>Сценарии</h2><table><thead><tr><th>Статус</th><th>Сценарий</th><th>Что не так</th></tr></thead><tbody>
${sc.scenarios.map((r) => `<tr><td class="${cls(r.status)}">${r.status.toUpperCase()}</td><td><b>${esc(r.scenario)}</b> <span style="color:var(--dim)">${esc(r.viewport)}</span></td>
  <td>${esc([...r.checks.filter((c) => c.status !== 'pass').map((c) => `${c.name}: ${c.detail}`),
             ...r.errors.slice(0, 2).map((e) => `${e.kind}: ${e.text}`)].join(' · ') || '—')}</td></tr>`).join('')}
</tbody></table>`;
}

function botsSection(a) {
  return `<h2>Боты</h2>
<table><thead><tr><th>Профиль</th><th>Прогонов</th><th>Winrate</th><th>Медиана времени</th><th>p10–p90</th><th>Медиана очков</th><th>Медиана уровня</th></tr></thead><tbody>
${a.bots.map((b) => `<tr><td><b>${esc(b.bot)}</b></td><td>${b.runs}</td>
  <td>${(b.winrate * 100).toFixed(0)}% <span style="color:var(--dim)">±${(((b.winrateHi - b.winrateLo) / 2) * 100).toFixed(0)}</span></td>
  <td>${b.medianSeconds}с</td><td>${b.p10Seconds}–${b.p90Seconds}с</td><td>${b.medianScore}</td><td>${b.medianLevel}</td></tr>`).join('')}
</tbody></table>`;
}

function difficultySection(a) {
  const L = a.levels.filter((x) => x.clearRate !== null);
  if (!L.length) return '';
  return `<h2>Кривая сложности</h2>
${lineChart(L.map((x) => ({ x: x.level, y: x.clearRate, lo: x.clearRateLo, hi: x.clearRateHi })), {
    yLabel: 'проходимость', xLabel: 'уровень', bands: [{ from: 0, to: 0.25, color: '#f8514922', label: 'стена' }, { from: 0.95, to: 1, color: '#d2992222', label: 'скучно' }],
  })}
<h2>Тепловая карта уровней</h2>
${heatmap(L)}
<table><thead><tr><th>Ур.</th><th>Попыток</th><th>Проходимость</th><th>Медиана</th><th>Главная причина конца</th></tr></thead><tbody>
${L.map((x) => `<tr><td>${x.level}</td><td>${x.attempts}</td><td>${(x.clearRate * 100).toFixed(0)}%</td><td>${x.medianSeconds ?? '—'}с</td><td>${x.topCauses[0] ? esc(x.topCauses[0][0]) + ' ×' + x.topCauses[0][1] : '—'}</td></tr>`).join('')}
</tbody></table>`;
}

function progressSection(a) {
  const keys = Object.keys(a.progress[0]).filter((k) => k !== 't' && k !== 'seconds');
  return `<h2>Кривые прогресса</h2>` + keys.map((k) => `<div style="margin-bottom:18px"><b>${esc(k)}</b>${
    lineChart(a.progress.map((r) => ({ x: r.seconds, y: r[k].med, lo: r[k].p10, hi: r[k].p90 })), { xLabel: 'секунды', yLabel: k, autoY: true })
  }</div>`).join('');
}

function flagsSection(a) {
  return `<h2>Флаги баланса</h2>` + a.flags.map((f) => `<div class="flag ${f.severity}">
    <b>[${esc(f.kind)}]</b>${f.level ? ` уровень ${f.level}` : ''} — ${esc(f.detail)}
    ${f.hint ? `<div style="color:var(--dim);font-size:12px">${esc(f.hint)}</div>` : ''}</div>`).join('');
}

function shotsSection(shots, dir) {
  return `<h2>Кадры</h2><div class="shots">` + shots.map((s) => {
    const rel = path.relative(dir, s.file);
    return `<div class="shot"><img src="${esc(rel)}" alt="${esc(s.label)}"><div class="cap"><b>${esc(s.label)}</b>${s.note ? ' — ' + esc(s.note) : ''}</div></div>`;
  }).join('') + `</div>`;
}

// --- примитивы графиков ---

function lineChart(pts, { yLabel = '', xLabel = '', bands = [], autoY = false, w = 900, h = 240 } = {}) {
  if (!pts.length) return '';
  const pad = { l: 46, r: 14, t: 12, b: 30 };
  const xs = pts.map((p) => p.x);
  const ysAll = pts.flatMap((p) => [p.y, p.lo ?? p.y, p.hi ?? p.y]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs) || 1;
  const yMin = autoY ? Math.min(0, ...ysAll) : 0;
  const yMax = autoY ? (Math.max(...ysAll) || 1) : 1;
  const X = (x) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * (w - pad.l - pad.r);
  const Y = (y) => h - pad.b - ((y - yMin) / (yMax - yMin || 1)) * (h - pad.t - pad.b);

  const bandRects = bands.map((b) => `<rect x="${pad.l}" y="${Y(b.to)}" width="${w - pad.l - pad.r}" height="${Math.max(0, Y(b.from) - Y(b.to))}" fill="${b.color}"/>` +
    `<text x="${w - pad.r - 4}" y="${Y(b.to) + 12}" fill="var(--dim)" font-size="10" text-anchor="end">${esc(b.label || '')}</text>`).join('');

  const area = pts.some((p) => p.lo != null)
    ? `<path d="M${pts.map((p) => `${X(p.x)},${Y(p.hi ?? p.y)}`).join('L')}L${[...pts].reverse().map((p) => `${X(p.x)},${Y(p.lo ?? p.y)}`).join('L')}Z" fill="var(--acc)" opacity="0.15"/>`
    : '';
  const line = `<path d="M${pts.map((p) => `${X(p.x)},${Y(p.y)}`).join('L')}" fill="none" stroke="var(--acc)" stroke-width="2"/>`;
  const dots = pts.length <= 60 ? pts.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3" fill="var(--acc)"/>`).join('') : '';

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const grid = yTicks.map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-dasharray="2,3"/>` +
    `<text x="${pad.l - 6}" y="${Y(v) + 4}" fill="var(--dim)" font-size="10" text-anchor="end">${autoY ? fmt(v) : Math.round(v * 100) + '%'}</text>`).join('');
  const xTicks = tickValues(xMin, xMax, 8).map((v) => `<text x="${X(v)}" y="${h - 10}" fill="var(--dim)" font-size="10" text-anchor="middle">${fmt(v)}</text>`).join('');

  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(yLabel)} по ${esc(xLabel)}">
    ${bandRects}${grid}${area}${line}${dots}${xTicks}
    <text x="${w / 2}" y="${h - 0}" fill="var(--dim)" font-size="10" text-anchor="middle">${esc(xLabel)}</text>
  </svg>`;
}

function heatmap(levels, { cell = 46, w = 900 } = {}) {
  const perRow = Math.max(1, Math.floor((w - 10) / cell));
  const rows = Math.ceil(levels.length / perRow);
  const h = rows * cell + 10;
  const cells = levels.map((L, i) => {
    const cx = (i % perRow) * cell + 4, cy = Math.floor(i / perRow) * cell + 4;
    // зелёный = проходят, красный = стена
    const p = L.clearRate;
    const col = `hsl(${Math.round(p * 120)} 60% ${p > 0.9 ? 32 : 42}%)`;
    return `<g><rect x="${cx}" y="${cy}" width="${cell - 6}" height="${cell - 6}" rx="5" fill="${col}"/>
      <text x="${cx + (cell - 6) / 2}" y="${cy + 17}" font-size="11" fill="#fff" text-anchor="middle" font-weight="600">${L.level}</text>
      <text x="${cx + (cell - 6) / 2}" y="${cy + 31}" font-size="10" fill="#ffffffcc" text-anchor="middle">${Math.round(p * 100)}%</text>
      <title>уровень ${L.level}: ${L.clears}/${L.attempts} прохождений${L.medianSeconds ? `, медиана ${L.medianSeconds}с` : ''}</title></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}">${cells}</svg>`;
}

function tickValues(min, max, n) {
  if (max === min) return [min];
  const step = (max - min) / (n - 1);
  return Array.from({ length: n }, (_, i) => min + i * step);
}

const fmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v / 100) / 10 + 'k' : Math.round(v * 10) / 10);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function printReport(file) {
  console.log(color.b('\nОтчёт: ') + file);
}
