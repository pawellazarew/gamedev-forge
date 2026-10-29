import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../../blender-kit/blend.sh', import.meta.url));

test('Blender wrapper forwards paths with spaces and rejects incomplete inputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge blender '));
  try {
    const fake = path.join(dir, 'fake blender');
    fs.writeFileSync(fake, '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const script = path.join(dir, 'model script.py');
    const blend = path.join(dir, 'model file.blend');
    fs.writeFileSync(script, '');
    fs.writeFileSync(blend, '');
    const run = (args) => spawnSync('bash', [wrapper, ...args], {
      env: { ...process.env, BLENDER_APP: fake }, encoding: 'utf8',
    });
    const ok = run([script, '--blend', blend, '--', '--out', 'output with spaces.png']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.stdout.trim().split('\n'), [
      '-b', blend, '-P', script, '--', '--out', 'output with spaces.png',
    ]);
    const missing = run([script, '--blend']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /requires a file path/);
    const nonexistent = run([path.join(dir, 'missing.py')]);
    assert.equal(nonexistent.status, 1);
    assert.match(nonexistent.stderr, /Script not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
