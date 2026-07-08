import { describe, expect, test } from "bun:test";
import fixtures from "./qr-fixtures.json";
import { buildDataCodewords, type ECLevel, qrModules, reedSolomon, renderQR } from "./qr";

// FIXTURE PROVENANCE: qr-fixtures.json was generated ONCE with the known-good `qrcode` npm package
// (qrcode@1.5.4, the library behind `bunx qrcode`) and pinned. Exact command (run in a scratch dir
// after `bun add qrcode@1.5.4`):
//
//   const ref = QRCode.create([{ data: text, mode: "byte" }], { errorCorrectionLevel: "L", maskPattern: mask });
//   fixture = { text, mask, size: ref.modules.size, data: Array.from(ref.modules.data).map(b => b ? 1 : 0).join("") };
//
// The `[{ data, mode: "byte" }]` segment form forces a single byte-mode segment — our minimal
// encoder is byte-only by design, while qrcode's auto-segmentation would split the long pairing URL
// into mixed Byte/Numeric segments (a different, equally valid QR). `maskPattern` is pinned to the
// mask OUR auto-selection picks for that text: the two libraries' mask-penalty scorers legitimately
// diverge (ours is Nayuki's border-extending N3 reading of ISO 18004; qrcode's N3 scan stops at the
// symbol edge), so for some payloads they auto-pick different — equally valid, equally scannable —
// masks (verified for pairUrl at level L: ours mask 2 vs qrcode's 3; the matrices are byte-for-byte
// identical once either mask is pinned on BOTH sides, and both decode exactly under the independent
// `jsqr` decoder). With mode + mask pinned, the two implementations produce byte-for-byte identical
// MODULE MATRICES (data encoding, Reed-Solomon, interleave, data placement, format/version bits) —
// asserted here against our AUTO output, so a drift in our mask selection also fails loudly.
//
// The payloads cover the interesting regimes across both EC levels:
//   - `short`    → level L, version 2 (single EC block, one alignment pattern, no version info)
//   - `pairUrl`  → level L, version 7 (multi-block interleave, timing-straddling alignment, version info)
//   - `pairUrlQ` → level Q, version 10 (the browser-page logo-overlay QR: higher recovery, multi-block
//                  interleave with the Q group split, version info) — exercises the Q EC/block tables and
//                  the Q format EC indicator (11), pinned byte-for-byte against qrcode@1.5.4's `Q` output.
// Each fixture carries its own `level` (older L fixtures default to "L").

describe("qr matrix vs pinned qrcode@1.5.4 fixtures", () => {
  for (const [name, fx] of Object.entries(fixtures) as [string, { text: string; mask: number; size: number; data: string; level?: ECLevel }][]) {
    const level = fx.level ?? "L";
    test(`${name} (${fx.text.length} chars → ${fx.size}x${fx.size}, level ${level}) matches the reference matrix exactly`, () => {
      const mine = qrModules(fx.text, level);
      expect(mine.size).toBe(fx.size);
      expect(mine.data.join("")).toBe(fx.data);
    });
  }
});

describe("qr internals against published ISO/IEC 18004 worked examples", () => {
  // The canonical "HELLO WORLD" v1-M worked example (thonky.com/qr-code-tutorial): these 16 data
  // codewords must produce exactly these 10 EC codewords.
  test("reedSolomon matches the HELLO WORLD v1-M vector", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test("buildDataCodewords: byte mode header, terminator, and 0xEC/0x11 padding", () => {
    // "hello" in v1-L: 0100 | 00000101 | h e l l o | 0000 terminator | pad to 19 codewords.
    const cw = buildDataCodewords(new TextEncoder().encode("hello"), 1);
    expect(cw.length).toBe(19);
    expect(cw.slice(0, 7)).toEqual([0x40, 0x56, 0x86, 0x56, 0xc6, 0xc6, 0xf0]);
    expect(cw.slice(7)).toEqual([236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17]);
  });
});

describe("renderQR (half-block terminal rendering)", () => {
  const text = (fixtures as Record<string, { text: string }>).short.text;

  test("geometry: the standard 4-module quiet zone (nothing beyond), two matrix rows per line", () => {
    const { size } = qrModules(text);
    const lines = renderQR(text).split("\n");
    expect(lines.length).toBe(Math.ceil((size + 8) / 2));
    for (const line of lines) expect(line.length).toBe(size + 8);
  });

  test("uses only the four half-block glyphs and keeps the quiet zone blank", () => {
    const lines = renderQR(text).split("\n");
    for (const line of lines) {
      expect([...line].every((ch) => ch === " " || ch === "▀" || ch === "▄" || ch === "█")).toBe(true);
      expect(line.startsWith("    ")).toBe(true);
      expect(line.endsWith("    ")).toBe(true);
    }
    // Top quiet zone: the first two lines cover matrix rows -4..-1, i.e. all-light.
    expect(lines[0].trim()).toBe("");
    expect(lines[1].trim()).toBe("");
  });

  test("rendering agrees cell-for-cell with the matrix", () => {
    const { size, data } = qrModules(text);
    const at = (r: number, c: number): boolean => {
      if (r < 0 || c < 0 || r >= size || c >= size) return false;
      return data[r * size + c] === 1;
    };
    const lines = renderQR(text).split("\n");
    for (let r = -4; r < size + 4; r += 2) {
      for (let c = -4; c < size + 4; c++) {
        const top = at(r, c);
        const bottom = at(r + 1, c);
        const expected = top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
        expect(lines[(r + 4) / 2][c + 4]).toBe(expected);
      }
    }
  });
});
