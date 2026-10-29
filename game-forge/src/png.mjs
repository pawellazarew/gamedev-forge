import zlib from 'node:zlib';

/** Minimal PNG decoder for Chromium screenshots: 8 bits per channel, color
 * type 2 (RGB) or 6 (RGBA), without interlacing.
 * Reading WebGL pixels inside the page without preserveDrawingBuffer returns
 * a cleared black image. Playwright captures the compositor output seen by
 * the player, so decode that screenshot here instead. */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];

  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + data + CRC
  }

  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: depth=${depth} colorType=${colorType} interlace=${interlace}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Reconstruct scanlines using PNG filters 0 through 4.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      switch (filter) {
        case 0: cur[x] = v; break;
        case 1: cur[x] = (v + a) & 0xff; break;
        case 2: cur[x] = (v + b) & 0xff; break;
        case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[x] = (v + pred) & 0xff;
          break;
        }
        default: throw new Error(`unknown scanline filter: ${filter}`);
      }
    }
  }
  return { width, height, channels, data: out };
}

/** Fraction of changed pixels between two frames, from 0 to 1.
 * A byte comparison can mistake a blinking corner counter for a live game;
 * a ratio lets us require meaningful movement. Different dimensions mean
 * a different frame and return 1. */
export function pixelDiffRatio(a, b, { threshold = 8 } = {}) {
  const A = decodePng(a);
  const B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) return 1;

  let changed = 0, n = 0;
  // Use the same sparse grid as frameStats. Checking all four million pixels
  // is unnecessary for detecting movement.
  const stepX = Math.max(1, Math.floor(A.width / 240));
  const stepY = Math.max(1, Math.floor(A.height / 240));
  for (let y = 0; y < A.height; y += stepY) {
    for (let x = 0; x < A.width; x += stepX) {
      const ia = y * A.width * A.channels + x * A.channels;
      const ib = y * B.width * B.channels + x * B.channels;
      n++;
      // A per-channel threshold ignores compression and antialiasing noise, not movement.
      if (Math.abs(A.data[ia] - B.data[ib]) > threshold
        || Math.abs(A.data[ia + 1] - B.data[ib + 1]) > threshold
        || Math.abs(A.data[ia + 2] - B.data[ib + 2]) > threshold) changed++;
    }
  }
  return n ? changed / n : 0;
}

/** Frame statistics distinguish a drawn image from an empty rectangle.
 * A sparse grid provides sufficient precision with less work. */
export function frameStats(buffer, { grid = 96 } = {}) {
  const img = decodePng(buffer);
  const { width, height, channels, data } = img;
  const stepX = Math.max(1, Math.floor(width / grid));
  const stepY = Math.max(1, Math.floor(height / grid));

  let sum = 0, n = 0, min = 255, max = 0;
  const colors = new Set();
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = y * width * channels + x * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum; n++;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)); // 12-bit bucket
    }
  }
  return {
    w: width,
    h: height,
    meanLum: +(sum / n).toFixed(1),
    minLum: Math.round(min),
    maxLum: Math.round(max),
    distinctColors: colors.size,
    sampled: n,
  };
}
