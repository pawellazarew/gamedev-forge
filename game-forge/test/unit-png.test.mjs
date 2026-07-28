import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, frameStats } from '../src/png.mjs';

/** Минимальный энкодер PNG — чтобы тест не зависел от внешних файлов. */
function encodePng(width, height, rgba, { colorType = 6 } = {}) {
  const channels = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc(height * (width * channels + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * channels + 1)] = 0; // фильтр None
    rgba.copy(raw, y * (width * channels + 1) + 1, y * width * channels, (y + 1) * width * channels);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function solid(width, height, [r, g, b]) {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) px.set([r, g, b, 255], i * 4);
  return encodePng(width, height, px);
}

describe('decodePng', () => {
  test('размеры и пиксели читаются как записаны', () => {
    const img = decodePng(solid(8, 4, [10, 20, 30]));
    assert.equal(img.width, 8);
    assert.equal(img.height, 4);
    assert.equal(img.channels, 4);
    assert.deepEqual([...img.data.subarray(0, 4)], [10, 20, 30, 255]);
  });

  test('RGB без альфы тоже поддерживается', () => {
    const px = Buffer.alloc(4 * 4 * 3, 77);
    const img = decodePng(encodePng(4, 4, px, { colorType: 2 }));
    assert.equal(img.channels, 3);
    assert.equal(img.data[0], 77);
  });

  test('не-PNG отвергается внятной ошибкой', () => {
    assert.throws(() => decodePng(Buffer.from('это не картинка')), /не PNG/);
  });
});

describe('frameStats — «живой ли кадр»', () => {
  test('однотонная заливка распознаётся как мёртвый кадр', () => {
    const s = frameStats(solid(64, 64, [0, 0, 0]));
    assert.equal(s.distinctColors, 1);
    assert.equal(s.maxLum - s.minLum, 0, 'ровно тот случай, ради которого проверка и нужна');
  });

  test('картинка с содержимым даёт разброс цвета и яркости', () => {
    const w = 64, h = 64;
    const px = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const bright = (i % 7) * 36;
      px.set([bright, 255 - bright, (i * 3) % 255, 255], i * 4);
    }
    const s = frameStats(encodePng(w, h, px));
    assert.ok(s.distinctColors > 5);
    assert.ok(s.maxLum - s.minLum > 50);
  });

  test('яркость считается по светимости, а не по среднему каналу', () => {
    // Чистый зелёный субъективно ярче чистого синего той же величины
    const green = frameStats(solid(16, 16, [0, 255, 0]));
    const blue = frameStats(solid(16, 16, [0, 0, 255]));
    assert.ok(green.meanLum > blue.meanLum * 5);
  });
});
