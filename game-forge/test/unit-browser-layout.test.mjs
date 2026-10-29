import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

 test('Chromium discovery supports the chrome-linux64 Playwright layout', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-browser-'));
  try {
    const executable = path.join(cache, 'chromium-999999', 'chrome-linux64', 'chrome');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '');
    const moduleUrl = new URL('../src/browser.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { findChromium } from ${JSON.stringify(moduleUrl)}; console.log(findChromium());`], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), executable);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
