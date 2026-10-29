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

/** Zero-configuration static server rooted at the game directory. A small local
 * implementation keeps CI behavior predictable without another dependency.
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, bytes: () => number}>} */
export function serve(root, { port = 0 } = {}) {
  // Canonicalize the root first: macOS /tmp is a symlink to /private/tmp,
  // so string comparisons otherwise compare different spellings of one path.
  const abs = fs.realpathSync(path.resolve(root));
  let served = 0;

  const server = http.createServer((req, res) => {
    // decodeURIComponent throws on malformed percent encoding such as /%E0%A4%A.
    // Fail only this request rather than crashing the whole forge process.
    let url;
    try {
      url = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    let file = path.resolve(abs, '.' + path.posix.normalize('/' + url));

    // Two-stage path validation: textual checks catch ../ but cannot detect
    // a symlink inside the root pointing outside it.
    const inside = (p) => {
      const rel = path.relative(abs, p);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    if (!inside(file)) { res.writeHead(403).end('forbidden'); return; }

    try {
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }

      // Second stage: resolve where the path actually points.
      const real = fs.realpathSync(file);
      if (!inside(real)) { res.writeHead(403).end('forbidden'); return; }
      file = real;

      const body = fs.readFileSync(file);
      served += body.length;
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
        // Many engines require cross-origin isolation for SharedArrayBuffer.
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
