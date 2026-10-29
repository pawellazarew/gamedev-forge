import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { combineVerdict, report } from '../src/report.mjs';
import { loadConfig, loadAdapter, loadScenarios } from '../src/harness.mjs';

describe('combineVerdict — worst status wins', () => {
  test('failing probe overrides passing balance', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'fail' }, analysis: { verdict: 'ok' } }), 'fail');
  });

  test('scenario failure also fails the report', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'pass' }, scenarios: { status: 'fail' } }), 'fail');
  });

  test('needs-work balance fails the report even when technical checks pass', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'pass' }, analysis: { verdict: 'needs-work' } }), 'needs-work');
  });

  test('warn becomes watch, not failure', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'warn' }, analysis: { verdict: 'ok' } }), 'warn');
  });

  test('all clear means pass', () => {
    assert.equal(combineVerdict({ probe: { verdict: 'pass' }, analysis: { verdict: 'ok' }, scenarios: { status: 'pass' } }), 'pass');
  });

  test('missing data does not invent a failure', () => {
    assert.equal(combineVerdict({}), 'ok');
  });
});

describe('report', () => {
  const cfg = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-report-'));
    return { name: 'Test game', dir, referencesDir: path.join(dir, 'refs') };
  };

  test('HTML is self-contained: no external requests', () => {
    const file = report(cfg(), {
      probe: { verdict: 'pass', frameWorkMs: 1, frameWorkP99Ms: 2, frameWorkMaxMs: 3, mainThreadBusy: 0.1, headroom: 16, errorCount: 0, bundleKb: 10, loadMs: 100, drawCallsPerFrame: 0, checks: [], errors: [] },
    });
    const html = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(html, /<script src=|<link[^>]+href="http/i, 'report must open offline');
    assert.match(html, /Test game/);
  });

  test('failing probe is visible in the report header', () => {
    const file = report(cfg(), {
      probe: { verdict: 'fail', frameWorkMs: 99, frameWorkP99Ms: 200, frameWorkMaxMs: 300, mainThreadBusy: 0.9, headroom: 0.2, errorCount: 3, bundleKb: 9999, loadMs: 9000, drawCallsPerFrame: 50, checks: [{ name: 'frame-work', status: 'fail', detail: 'slow' }], errors: [] },
      analysis: { verdict: 'ok', bots: [], levels: [], flags: [], progress: [] },
    });
    assert.match(fs.readFileSync(file, 'utf8'), /Needs work/);
  });

  test('escaping: game names cannot inject markup', () => {
    const c = cfg();
    c.name = '<img src=x onerror=alert(1)>';
    const html = fs.readFileSync(report(c, {}), 'utf8');
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
});

describe('loadConfig / loadAdapter', () => {
  const write = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cfg-'));
    for (const [name, body] of Object.entries(files)) {
      const f = path.join(dir, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
    return dir;
  };

  test('defaults are applied and explicit values win', async () => {
    const dir = write({ 'forge.config.mjs': 'export default { name: "X", budgets: { errors: 5 } }' });
    const cfg = await loadConfig(dir);
    assert.equal(cfg.name, 'X');
    assert.equal(cfg.entry, 'index.html');
    assert.equal(cfg.renderer, '2d');
    assert.equal(cfg.budgets.errors, 5, 'explicit value');
    assert.equal(cfg.budgets.frameMs, 16.7, 'other budgets use defaults');
  });

  test('missing config gives a helpful error', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-empty-'));
    await assert.rejects(() => loadConfig(empty), /forge\.config\.mjs/);
  });

  test('an undeclared adapter is not an error', async () => {
    const dir = write({ 'forge.config.mjs': 'export default { name: "X" }' });
    assert.equal(await loadAdapter(await loadConfig(dir)), null);
  });

  test('a declared but missing adapter fails', async () => {
    const dir = write({ 'forge.config.mjs': 'export default { name: "X", adapter: "./forge/adapter.mjs" }' });
    const cfg = await loadConfig(dir);
    await assert.rejects(() => loadAdapter(cfg), /Adapter not found/);
  });

  test('adapter without install() fails instead of being treated as absent', async () => {
    const dir = write({
      'forge.config.mjs': 'export default { name: "X", adapter: "./forge/adapter.mjs" }',
      'forge/adapter.mjs': 'export default { autostart: true }',
    });
    const cfg = await loadConfig(dir);
    await assert.rejects(() => loadAdapter(cfg), /install\(\)/);
  });

  test('broken adapter throws a syntax error', async () => {
    const dir = write({
      'forge.config.mjs': 'export default { name: "X", adapter: "./forge/adapter.mjs" }',
      'forge/adapter.mjs': 'export default { install() { this is not JS } }',
    });
    const cfg = await loadConfig(dir);
    await assert.rejects(() => loadAdapter(cfg));
  });

  test('missing scenario file gives an empty list', async () => {
    const dir = write({ 'forge.config.mjs': 'export default { name: "X" }' });
    const cfg = await loadConfig(dir);
    assert.deepEqual(await loadScenarios(cfg), []);
  });
});
