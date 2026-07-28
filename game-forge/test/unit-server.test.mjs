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
  // Сосед с тем же префиксом имени — ровно тот случай, который пропускала
  // проверка через startsWith
  sibling = path.join(base, 'game-secret');
  fs.mkdirSync(root); fs.mkdirSync(sibling);
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), '<h1>sub</h1>');
  fs.writeFileSync(path.join(root, 'main.js'), 'console.log(1)');
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'НЕ ДОЛЖНО УТЕЧЬ');
  srv = await serve(root);
});

after(async () => { await srv.close(); });

const get = (p) => fetch(srv.url + p);

describe('раздача файлов', () => {
  test('корень отдаёт index.html', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<h1>ok<\/h1>/);
  });

  test('подкаталог тоже отдаёт свой index.html', async () => {
    assert.equal((await get('/sub')).status, 200);
    assert.equal((await get('/sub/')).status, 200);
  });

  test('MIME проставляется по расширению', async () => {
    const r = await get('/main.js');
    assert.match(r.headers.get('content-type'), /javascript/);
  });

  test('несуществующий файл — 404, а не падение', async () => {
    assert.equal((await get('/nope.png')).status, 404);
  });

  test('счётчик отданных байт растёт', async () => {
    const before = srv.bytes();
    await get('/main.js');
    assert.ok(srv.bytes() > before);
  });
});

describe('безопасность', () => {
  test('выход за корень через ../ запрещён', async () => {
    for (const p of ['/../game-secret/secret.txt', '/sub/../../game-secret/secret.txt', '/%2e%2e/game-secret/secret.txt']) {
      const r = await get(p);
      assert.ok(r.status === 403 || r.status === 404, `${p} → ${r.status}`);
      assert.doesNotMatch(await r.text(), /НЕ ДОЛЖНО УТЕЧЬ/);
    }
  });

  test('соседний каталог с общим префиксом недоступен', async () => {
    // startsWith(abs) пропускал «/tmp/x/game-secret», потому что строка
    // действительно начинается с «/tmp/x/game»
    const r = await get('/../game-secret/secret.txt');
    assert.doesNotMatch(await r.text(), /НЕ ДОЛЖНО УТЕЧЬ/);
  });

  test('битый percent-encoding даёт 400 и не роняет сервер', async () => {
    const bad = await get('/%E0%A4%A');
    assert.equal(bad.status, 400);
    // главное — сервер жив после этого
    assert.equal((await get('/index.html')).status, 200);
  });
});
