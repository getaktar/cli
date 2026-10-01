import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inflateSync } from "node:zlib";
import { encodeQR, qrPNG, qrText, type QRCode } from "../src/qr.js";

// "https://getaktar.com" from Project Nayuki's reference implementation
// (byte mode, level M, mask chosen by penalty): version 2, mask 0.
const GETAKTAR = [
  "#######...#.#.##..#######",
  "#.....#.#.#.#..#..#.....#",
  "#.###.#...##...#..#.###.#",
  "#.###.#..#.#..#...#.###.#",
  "#.###.#.#..#.####.#.###.#",
  "#.....#..##.#.##..#.....#",
  "#######.#.#.#.#.#.#######",
  "..........#.###..........",
  "#.#.#.#.....##......#..#.",
  ".###.....#.#....###.....#",
  ".##..##...#......###..###",
  "##.###.......###.......#.",
  "#.#.#.#..#.#..#.###..#.##",
  ".###.#..####....#.#..#..#",
  "#.##.##...#..#..####..###",
  ".##.##.#####...###..#..#.",
  "#.#####.#.#.#...######...",
  "........#..###..#...##.##",
  "#######...###.###.#.##.##",
  "#.....#..##.###.#...##.#.",
  "#.###.#.##.#..#.######.##",
  "#.###.#...##..#.#..####..",
  "#.###.#.#....#......#...#",
  "#.....#..###...###..##.#.",
  "#######.##..#..#####...##",
];

const rows = (qr: QRCode) => qr.modules.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));

function hasFinder(qr: QRCode, left: number, top: number) {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (qr.modules[top + y][left + x] !== (ring !== 2)) return false;
    }
  }
  return true;
}

describe("encodeQR", () => {
  test("matches the reference implementation", () => {
    assert.deepEqual(rows(encodeQR("https://getaktar.com")), GETAKTAR);
  });

  test("picks the smallest version that fits", () => {
    // Byte capacity at level M: 14 (version 1), 26 (2), 84 (5), 106 (6), 2331 (40).
    const sizes = [
      ["a", 21],
      ["x".repeat(14), 21],
      ["x".repeat(15), 25],
      ["x".repeat(84), 37],
      ["x".repeat(85), 41],
      ["x".repeat(2331), 177],
    ] as const;
    for (const [text, size] of sizes) assert.equal(encodeQR(text).size, size, `${text.length} bytes`);
    // Counted in UTF-8 bytes, not characters.
    assert.equal(encodeQR("ç".repeat(13)).size, 25);
  });

  test("draws the finder patterns and the dark module", () => {
    for (const text of ["a", "https://files.example.com/2026/09/7f3c2a91.png", "y".repeat(500)]) {
      const qr = encodeQR(text);
      assert.equal(qr.modules.length, qr.size);
      assert.ok(hasFinder(qr, 0, 0) && hasFinder(qr, qr.size - 7, 0) && hasFinder(qr, 0, qr.size - 7));
      assert.equal(qr.modules[qr.size - 8][8], true);
    }
  });

  test("rejects text too long for a QR code", () => {
    assert.throws(() => encodeQR("x".repeat(2332)), /too long/);
  });
});

describe("qrText", () => {
  const qr = encodeQR("https://getaktar.com");
  const side = qr.size + 8;

  test("is two modules per line with a quiet zone", () => {
    const lines = qrText(qr).split("\n");
    assert.equal(lines.length, Math.ceil(side / 2));
    for (const line of lines) assert.equal([...line].length, side);
    // The quiet zone is light, which plain text draws as full blocks.
    assert.equal(lines[0], "█".repeat(side));
    assert.ok(lines.every((line) => line.startsWith("████") && line.endsWith("████")));
  });

  test("reads back as the same modules", () => {
    for (const color of [false, true]) {
      const grid: boolean[][] = [];
      for (const line of qrText(qr, { color }).split("\n")) {
        const chars = [...line.replace(/\u001b\[[0-9;]*m/g, "")];
        assert.equal(chars.length, side);
        // With color the blocks are the dark modules, without they're the light ones.
        const inked = (top: boolean) => chars.map((c) => c === "█" || c === (top ? "▀" : "▄"));
        grid.push(inked(true).map((ink) => ink === color), inked(false).map((ink) => ink === color));
      }
      const modules = grid.slice(4, 4 + qr.size).map((row) => row.slice(4, 4 + qr.size));
      assert.deepEqual(modules, qr.modules);
    }
  });

  test("draws black on white with color", () => {
    for (const line of qrText(qr, { color: true }).split("\n")) {
      assert.ok(line.startsWith("\u001b[38;5;16;48;5;231m") && line.endsWith("\u001b[0m"));
    }
  });
});

describe("qrPNG", () => {
  test("is a 1-bit PNG of the code with its quiet zone", () => {
    const qr = encodeQR("https://getaktar.com");
    const png = qrPNG(qr, 2);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const side = (qr.size + 8) * 2;
    assert.equal(png.readUInt32BE(16), side);
    assert.equal(png.readUInt32BE(20), side);
    assert.equal(png[24], 1);

    const idat = png.indexOf("IDAT");
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    const rowBytes = Math.ceil(side / 8) + 1;
    assert.equal(raw.length, rowBytes * side);
    const white = (x: number, y: number) => (raw[y * rowBytes + 1 + (x >>> 3)] & (0x80 >>> (x & 7))) !== 0;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) assert.equal(white(8 + x * 2, 8 + y * 2), !qr.modules[y][x]);
    }
    assert.ok(white(0, 0));
  });
});
