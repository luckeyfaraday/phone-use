// Minimal PNG reading, downscaling and writing, so iPhone screenshots can be scaled without
// ImageMagick or other dependencies. Reads non-interlaced 8- or 16-bit grayscale, RGB or RGBA
// (iPhone screenshots can be 16-bit) and writes 8-bit RGB.
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** → { width, height, channels, data } with 8-bit samples. */
export function decodePng(png) {
  if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG image.");
  let pos = 8, header = null;
  const idat = [];
  while (pos + 8 <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!header) throw new Error("PNG has no header.");
  const { width, height, depth, color, interlace } = header;
  const channels = CHANNELS[color];
  if ((depth !== 8 && depth !== 16) || !channels || interlace) throw new Error(`Unsupported PNG (bit depth ${depth}, color type ${color}, interlace ${interlace}).`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels * (depth / 8); // filters work on bytes, one pixel apart
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated.");
  const bytes = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? bytes[row + i - bpp] : 0;
      const b = y > 0 ? bytes[up + i] : 0;
      const c = y > 0 && i >= bpp ? bytes[up + i - bpp] : 0;
      let predicted;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = a; break;
        case 2: predicted = b; break;
        case 3: predicted = (a + b) >> 1; break;
        case 4: predicted = paeth(a, b, c); break;
        default: throw new Error(`Bad PNG filter ${filter}.`);
      }
      bytes[row + i] = (raw[line + i] + predicted) & 0xff;
    }
  }
  if (depth === 8) return { width, height, channels, data: bytes };
  // 16-bit samples (wide-color iPhone screenshots) are big-endian: keep the high byte.
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < data.length; i++) data[i] = bytes[i * 2];
  return { width, height, channels, data };
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Area-average an image down to width × height and drop alpha: → RGB { width, height, data }. */
export function downscale(image, width, height) {
  const { width: sw, height: sh, channels, data } = image;
  if (width < 1 || height < 1 || width > sw || height > sh) throw new Error("Can only shrink an image.");
  const out = Buffer.alloc(width * height * 3);
  const gray = channels < 3;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * sh) / height), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * sw) / width), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width));
      let r = 0, g = 0, b = 0;
      for (let sy = y0; sy < y1; sy++) {
        let p = (sy * sw + x0) * channels;
        for (let sx = x0; sx < x1; sx++, p += channels) {
          r += data[p];
          g += gray ? data[p] : data[p + 1];
          b += gray ? data[p] : data[p + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0), o = (y * width + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return { width, height, channels: 3, data: out };
}

/** RGB image → PNG, choosing each row's filter by the usual minimum-sum heuristic. */
export function encodePng({ width, height, data }) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride, up = row - stride, line = y * (stride + 1);
    let best = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? data[row + i - 3] : 0;
        const b = y > 0 ? data[up + i] : 0;
        const c = y > 0 && i >= 3 ? data[up + i - 3] : 0;
        const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const value = (data[row + i] - predicted) & 0xff;
        candidate[i] = value;
        sum += value < 128 ? value : 256 - value;
      }
      if (sum < best) {
        best = sum;
        raw[line] = filter;
        candidate.copy(raw, line + 1);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// zlib.crc32 needs Node 20.15+; this package supports Node 18.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Width and height from a PNG header, without decoding it. */
export function pngSize(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG image.");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
