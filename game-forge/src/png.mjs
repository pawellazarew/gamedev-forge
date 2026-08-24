import zlib from 'node:zlib';

/**
 * Минимальный декодер PNG — ровно то подмножество, которое отдаёт Chromium:
 * 8 бит на канал, цветовой тип 2 (RGB) или 6 (RGBA), без интерлейса.
 *
 * Зачем свой: анализировать кадр через canvas внутри страницы нельзя —
 * у WebGL-контекста без preserveDrawingBuffer буфер уже очищен, и любой
 * `drawImage` возвращает чёрный прямоугольник. Скриншот Playwright снимается
 * композитором и показывает то же, что видит игрок, но его надо разобрать здесь.
 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('не PNG');

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
    pos += 12 + len; // длина + тип + данные + CRC
  }

  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`неподдерживаемый PNG: depth=${depth} colorType=${colorType} interlace=${interlace}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Расфильтровка построчно (спецификация PNG, фильтры 0..4)
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
        default: throw new Error(`неизвестный фильтр строки: ${filter}`);
      }
    }
  }
  return { width, height, channels, data: out };
}

/**
 * Доля изменившихся пикселей между двумя кадрами, 0..1.
 *
 * Побайтового сравнения буферов мало: один моргающий счётчик кадров в углу —
 * и «картинка изменилась», хотя игра застыла. Доля же позволяет требовать
 * заметного движения, а не любого.
 *
 * Разный размер — это не «немного изменилось», а другой кадр: 1.
 */
export function pixelDiffRatio(a, b, { threshold = 8 } = {}) {
  const A = decodePng(a);
  const B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) return 1;

  let changed = 0, n = 0;
  // Та же прореженная сетка, что и во frameStats: полный проход по 4 млн
  // пикселей ради «шевелится или нет» не нужен.
  const stepX = Math.max(1, Math.floor(A.width / 240));
  const stepY = Math.max(1, Math.floor(A.height / 240));
  for (let y = 0; y < A.height; y += stepY) {
    for (let x = 0; x < A.width; x += stepX) {
      const ia = y * A.width * A.channels + x * A.channels;
      const ib = y * B.width * B.channels + x * B.channels;
      n++;
      // Порог по каналу гасит шум сжатия и сглаживания, но не движение.
      if (Math.abs(A.data[ia] - B.data[ib]) > threshold
        || Math.abs(A.data[ia + 1] - B.data[ib + 1]) > threshold
        || Math.abs(A.data[ia + 2] - B.data[ib + 2]) > threshold) changed++;
    }
  }
  return n ? changed / n : 0;
}

/**
 * Статистика кадра: «живой» он или пустой прямоугольник.
 * Считаем по прореженной сетке — точности хватает, а времени уходит меньше.
 */
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
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)); // 12-битное ведро
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
