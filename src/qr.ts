import { deflateSync } from "node:zlib";

/**
 * QR codes for `aktar upload --qr` and `aktar qr`. The encoder handles
 * links and other text: byte mode, error correction level M, the smallest
 * version that fits and the mask with the lowest penalty. Pure TypeScript,
 * after Project Nayuki's QR Code generator (MIT), the same code as Aktar's
 * mobile app, so the CLI keeps zero dependencies.
 */

/** Error correction codewords per block at level M, by version (index 0 unused). */
const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** Error correction blocks at level M, by version (index 0 unused). */
const NUM_ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37,
  38, 40, 43, 45, 47, 49,
];

/** Level M in the format information. */
const ECL_FORMAT_BITS = 0;

export type QRCode = {
  /** Modules per side, without the quiet zone. */
  size: number;
  /** `modules[y][x]` is true for a dark module. */
  modules: boolean[][];
};

/** The light margin scanners need around the code, in modules. */
const QUIET_ZONE = 4;

/** The QR code for `text` (UTF-8). Throws when it's too long for a QR code (about 2300 bytes). */
export function encodeQR(text: string): QRCode {
  const data = utf8Bytes(text);
  let version = 1;
  let dataCapacityBits = 0;
  for (; ; version++) {
    if (version > 40) throw new Error("That's too long for a QR code.");
    dataCapacityBits = numDataCodewords(version) * 8;
    if (4 + (version < 10 ? 8 : 16) + data.length * 8 <= dataCapacityBits) break;
  }

  // Byte mode segment, terminator and padding.
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, data.length, version < 10 ? 8 : 16);
  for (const b of data) appendBits(bits, b, 8);
  appendBits(bits, 0, Math.min(4, dataCapacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < dataCapacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const codewords: number[] = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, i) => {
    codewords[i >>> 3] |= bit << (7 - (i & 7));
  });

  const qr = new Builder(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addEccAndInterleave(codewords, version));

  let bestMask = 0;
  let minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormatBits(mask);
    const penalty = qr.penaltyScore();
    if (penalty < minPenalty) {
      bestMask = mask;
      minPenalty = penalty;
    }
    qr.applyMask(mask); // XOR undoes it
  }
  qr.applyMask(bestMask);
  qr.drawFormatBits(bestMask);
  return { size: qr.size, modules: qr.modules };
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function appendBits(bits: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number): number {
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[version] * NUM_ERROR_CORRECTION_BLOCKS[version];
}

function addEccAndInterleave(data: number[], version: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = reedSolomonDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = reedSolomonRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // Skip the padding byte in short blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function reedSolomonDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(private readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    positions.forEach((x, i) =>
      positions.forEach((y, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }),
    );

    // Reserves the format areas; the real bits are drawn with the mask.
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFinder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, distance !== 2 && distance !== 4);
      }
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  drawFormatBits(mask: number) {
    const data = (ECL_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true);
  }

  private drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  drawCodewords(data: number[]) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** The standard penalty rules: long runs, 2x2 blocks, finder-like patterns and dark/light balance. */
  penaltyScore(): number {
    const size = this.size;
    const m = this.modules;
    let result = 0;
    const line = (get: (i: number) => boolean) => {
      let score = 0;
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (get(i) === get(i - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
      // 1:1:3:1:1 with four light modules on one side.
      for (let i = 0; i + 10 < size; i++) {
        const pattern = [true, false, true, true, true, false, true];
        const core = pattern.every((dark, k) => get(i + k) === dark);
        if (!core) continue;
        const after = [7, 8, 9, 10].every((k) => !get(i + k));
        if (after) score += 40;
      }
      for (let i = 0; i + 10 < size; i++) {
        const pattern = [true, false, true, true, true, false, true];
        const before = [0, 1, 2, 3].every((k) => !get(i + k));
        if (before && pattern.every((dark, k) => get(i + 4 + k) === dark)) score += 40;
      }
      return score;
    };
    for (let y = 0; y < size; y++) result += line((x) => m[y][x]);
    for (let x = 0; x < size; x++) result += line((y) => m[y][x]);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    }
    let dark = 0;
    for (const row of m) for (const cell of row) if (cell) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + Math.max(0, k) * 10;
  }
}

// MARK: - Terminal

/**
 * The QR code as lines of text, two modules per character with Unicode half
 * blocks, quiet zone included. With `color`, it's drawn black on white
 * whatever the terminal's theme. Without (piped, or NO_COLOR), the light
 * modules are the ones drawn: a normal code on a dark terminal, an inverted
 * one on a light terminal, which phone cameras read as well.
 */
export function qrText(qr: QRCode, options: { color?: boolean } = {}): string {
  const side = qr.size + QUIET_ZONE * 2;
  const dark = (x: number, y: number) => {
    const mx = x - QUIET_ZONE;
    const my = y - QUIET_ZONE;
    return mx >= 0 && mx < qr.size && my >= 0 && my < qr.size && qr.modules[my][mx];
  };
  // Inked is what the character draws in the foreground color.
  const inked = (x: number, y: number) => (y < side ? dark(x, y) === Boolean(options.color) : !options.color);
  const lines: string[] = [];
  for (let y = 0; y < side; y += 2) {
    let line = "";
    for (let x = 0; x < side; x++) {
      const top = inked(x, y);
      const bottom = inked(x, y + 1);
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    // Black (16) on white (231) from the 256 colors, which themes leave alone.
    lines.push(options.color ? `\u001b[38;5;16;48;5;231m${line}\u001b[0m` : line);
  }
  return lines.join("\n");
}

// MARK: - PNG

/**
 * The QR code as a PNG: black on white, `scale` pixels per module, with the
 * quiet zone. One bit per pixel, so even a long presigned link stays a small
 * file, and every edge is sharp.
 */
export function qrPNG(qr: QRCode, scale = 16): Buffer {
  const side = (qr.size + QUIET_ZONE * 2) * scale;
  const rowBytes = Math.ceil(side / 8);
  // Filter byte (0, none) plus the packed row, for every row.
  const raw = Buffer.alloc((rowBytes + 1) * side);
  for (let y = 0; y < side; y++) {
    const my = Math.floor(y / scale) - QUIET_ZONE;
    const row = y * (rowBytes + 1);
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - QUIET_ZONE;
      const dark = my >= 0 && my < qr.size && mx >= 0 && mx < qr.size && qr.modules[my][mx];
      // In 1-bit grayscale, 1 is white.
      if (!dark) raw[row + 1 + (x >>> 3)] |= 0x80 >>> (x & 7);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

let crcTable: Uint32Array | null = null;

// node:zlib only has crc32 from Node 22 on.
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
