import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
};

/**
 * Статик-сервер под корень игры. Пишем свой, а не берём зависимость:
 * нужен один файл, ноль конфигурации и предсказуемое поведение в CI.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, bytes: () => number}>}
 */
export function serve(root, { port = 0 } = {}) {
  const abs = path.resolve(root);
  let served = 0;

  const server = http.createServer((req, res) => {
    // decodeURIComponent бросает на битом percent-encoding («/%E0%A4%A»);
    // без этого блока падал весь процесс forge, а не один запрос
    let url;
    try {
      url = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    let file = path.resolve(abs, '.' + path.posix.normalize('/' + url));
    // Не выпускаем за корень игры. Сравнение через relative, а не startsWith:
    // startsWith пропускает соседа с тем же префиксом («/games/app-secret»
    // начинается с «/games/app»).
    const rel = path.relative(abs, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end('forbidden'); return; }
    try {
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
      const body = fs.readFileSync(file);
      served += body.length;
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
        // многие движки просят cross-origin isolation под SharedArrayBuffer
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        bytes: () => served,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
