import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../src/server.mjs';

let root, sibling, srv;

before(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-server-'));
  root = path.join(base, 'game');
  // A sibling sharing the same name prefix reproduces the case missed by the
  // check using startsWith
  sibling = path.join(base, 'game-secret');
  fs.mkdirSync(root); fs.mkdirSync(sibling);
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), '<h1>sub</h1>');
  fs.writeFileSync(path.join(root, 'main.js'), 'console.log(1)');
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'MUST NOT LEAK');
  srv = await serve(root);
});

after(async () => { await srv.close(); });

const get = (p) => fetch(srv.url + p);

describe('file serving', () => {
  test('root serves index.html', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<h1>ok<\/h1>/);
  });

  test('subdirectories also serve their own index.html', async () => {
    assert.equal((await get('/sub')).status, 200);
    assert.equal((await get('/sub/')).status, 200);
  });

  test('MIME is set by extension', async () => {
    const r = await get('/main.js');
    assert.match(r.headers.get('content-type'), /javascript/);
  });

  test('missing file returns 404 rather than crashing', async () => {
    assert.equal((await get('/nope.png')).status, 404);
  });

  test('served-byte counter increases', async () => {
    const before = srv.bytes();
    await get('/main.js');
    assert.ok(srv.bytes() > before);
  });
});

describe('security', () => {
  test('traversal outside the root using ../ is blocked', async () => {
    for (const p of ['/../game-secret/secret.txt', '/sub/../../game-secret/secret.txt', '/%2e%2e/game-secret/secret.txt']) {
      const r = await get(p);
      assert.ok(r.status === 403 || r.status === 404, `${p} → ${r.status}`);
      assert.doesNotMatch(await r.text(), /MUST NOT LEAK/);
    }
  });

  test('sibling with a shared name prefix is inaccessible', async () => {
    // startsWith(abs) allowed /tmp/x/game-secret because the string
    // really starts with /tmp/x/game
    const r = await get('/../game-secret/secret.txt');
    assert.doesNotMatch(await r.text(), /MUST NOT LEAK/);
  });

  test('outward symlink does not expose external files', async () => {
    // A text-only path check allows this symlink: the path looks
    // valid but resolves outside the root
    const link = path.join(root, 'leak.txt');
    fs.symlinkSync(path.join(sibling, 'secret.txt'), link);
    try {
      const r = await get('/leak.txt');
      assert.equal(r.status, 403, `outward symlink returned ${r.status}`);
      assert.doesNotMatch(await r.text(), /MUST NOT LEAK/);
    } finally {
      fs.unlinkSync(link);
    }
  });

  test('symlink to a system file is also blocked', async () => {
    const link = path.join(root, 'hosts');
    fs.symlinkSync('/etc/hosts', link);
    try {
      const r = await get('/hosts');
      assert.equal(r.status, 403);
    } finally {
      fs.unlinkSync(link);
    }
  });

  test('symlink INSIDE the root still works', async () => {
    // Block escapes, not symlinks themselves: builds often
    // arrange assets using links within the tree
    const link = path.join(root, 'alias.js');
    fs.symlinkSync(path.join(root, 'main.js'), link);
    try {
      const r = await get('/alias.js');
      assert.equal(r.status, 200);
      assert.match(await r.text(), /console\.log/);
    } finally {
      fs.unlinkSync(link);
    }
  });

  test('malformed percent-encoding returns 400 without crashing the server', async () => {
    const bad = await get('/%E0%A4%A');
    assert.equal(bad.status, 400);
    // the server must remain alive afterward
    assert.equal((await get('/index.html')).status, 200);
  });
});
