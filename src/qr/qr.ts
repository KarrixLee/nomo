// qr.ts — vendored MINIMAL QR Code encoder (byte mode, EC level L, auto version 1..10) rendering to
// a half-block terminal string. NO runtime dependencies.
//
// Why vendored: the pairing CLI must print a scannable QR of a ~100–120 char `nomo://pair?…` URL
// inside a Claude Code slash-command transcript — a non-TTY, sequential stdout. A tiny self-contained
// encoder avoids a native/npm dependency in a script that also has to bundle (Task 2.3) and run under
// bun AND node >= 18. Uses only TextEncoder + plain arrays — no Bun.*, no node: imports.
//
// The algorithm is a faithful, compacted port of Project Nayuki's public-domain QR reference
// (ISO/IEC 18004): same data encoding, Reed–Solomon, block interleaving, mask-penalty selection, and
// format/version BCH. Because both this module and the `qrcode` npm package implement the same spec,
// their module matrices are byte-for-byte identical — which is exactly what qr.test.ts pins.

const encoder = new TextEncoder();

// ----- GF(256) arithmetic (primitive polynomial 0x11d, generator 2) -------------------------------
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed–Solomon error-correction codewords for `data` (the remainder of dividing the message
 *  polynomial by the degree-`ecLen` generator), computed with the streaming LFSR method. */
export function reedSolomon(data: number[], ecLen: number): number[] {
  // Generator polynomial coefficients (monic, length ecLen+1; gen[0] === 1).
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
    }
    gen = next;
  }
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// ----- Per-version tables, EC level L only --------------------------------------------------------
// Level L (~7% recovery) is the lowest EC level — chosen deliberately: this QR is scanned screen-to-
// camera at close range (no print smudging / occlusion), where L scans reliably, and L needs the
// smallest version for a given payload, so it renders the fewest terminal rows (each module row =
// half a text line). The pairing URL is ~75 chars → version 4 at L (vs 5 at M, 8 at M when `u` is
// present). If a payload ever needs recovery margin, bump the whole file back to M by swapping these
// three tables and the drawFormat EC indicator (01 → 00).
/** Total data codewords per version at level L. */
const L_TOTAL_DATA: Record<number, number> = {
  1: 19, 2: 34, 3: 55, 4: 80, 5: 108, 6: 136, 7: 156, 8: 194, 9: 232, 10: 274,
};
/** EC codewords per block at level L. */
const L_EC_PER_BLOCK: Record<number, number> = {
  1: 7, 2: 10, 3: 15, 4: 20, 5: 26, 6: 18, 7: 20, 8: 24, 9: 30, 10: 18,
};
/** Block structure at level L: list of [blockCount, dataCodewordsPerBlock] groups. */
const L_GROUPS: Record<number, [number, number][]> = {
  1: [[1, 19]], 2: [[1, 34]], 3: [[1, 55]], 4: [[1, 80]], 5: [[1, 108]],
  6: [[2, 68]], 7: [[2, 78]], 8: [[2, 97]], 9: [[2, 116]], 10: [[2, 68], [2, 69]],
};
/** Alignment-pattern centre coordinates per version. */
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

function getBit(x: number, i: number): number {
  return (x >>> i) & 1;
}

/** Smallest version (1..10) whose level-L data capacity fits `byteLen`; throws if it doesn't fit. */
function pickVersion(byteLen: number): number {
  for (let v = 1; v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + byteLen * 8 <= L_TOTAL_DATA[v] * 8) return v;
  }
  throw new Error(`payload too large for QR v1..10 at level L: ${byteLen} bytes`);
}

/** Byte-mode bitstream → data codewords: mode(0100) ‖ count ‖ bytes ‖ terminator ‖ pad(0xEC,0x11). */
export function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
  const totalData = L_TOTAL_DATA[version];
  const capacityBits = totalData * 8;
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  // Terminator: up to 4 zero bits, but not past capacity.
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  // Pad to a byte boundary.
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // Pad codewords (alternating 0xEC / 0x11) to fill the data capacity.
  const pad = [0xec, 0x11];
  for (let i = 0; codewords.length < totalData; i++) codewords.push(pad[i % 2]);
  return codewords;
}

/** Split data codewords into blocks, compute EC, and interleave into the final codeword sequence. */
function interleave(dataCodewords: number[], version: number): number[] {
  const ecLen = L_EC_PER_BLOCK[version];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let ptr = 0;
  for (const [count, dataLen] of L_GROUPS[version]) {
    for (let k = 0; k < count; k++) {
      const data = dataCodewords.slice(ptr, ptr + dataLen);
      ptr += dataLen;
      blocks.push({ data, ec: reedSolomon(data, ecLen) });
    }
  }
  const result: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) result.push(b.data[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) result.push(b.ec[i]);
  }
  return result;
}

// ----- Matrix construction ------------------------------------------------------------------------
interface Grid {
  size: number;
  modules: number[][]; // 0 = light, 1 = dark
  func: boolean[][]; // true = function module (not overwritten by data / mask)
}

function newGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(0)),
    func: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function setFn(g: Grid, r: number, c: number, val: number): void {
  if (r < 0 || c < 0 || r >= g.size || c >= g.size) return;
  g.modules[r][c] = val;
  g.func[r][c] = true;
}

function placeFinder(g: Grid, r: number, c: number): void {
  // 7x7 finder plus a 1-module light separator ring (dr/dc from -1..7).
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const inCore = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const isBorder = inCore && ((dr === 0 || dr === 6) || (dc === 0 || dc === 6));
      const isCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      setFn(g, r + dr, c + dc, inCore && (isBorder || isCenter) ? 1 : 0);
    }
  }
}

function placeAlignment(g: Grid, r: number, c: number): void {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const maxAbs = Math.max(Math.abs(dr), Math.abs(dc));
      setFn(g, r + dr, c + dc, maxAbs !== 1 ? 1 : 0);
    }
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const size = g.size;
  placeFinder(g, 0, 0);
  placeFinder(g, 0, size - 7);
  placeFinder(g, size - 7, 0);
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const val = i % 2 === 0 ? 1 : 0;
    if (!g.func[6][i]) setFn(g, 6, i, val);
    if (!g.func[i][6]) setFn(g, i, 6, val);
  }
  // Alignment patterns. Skip ONLY the three centres that fall inside finder patterns — the ones
  // straddling a timing line (e.g. centre (6,24)) ARE drawn, and their modules coincide with the
  // timing parity where they cross.
  const centres = ALIGN[version];
  const last = centres.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      placeAlignment(g, centres[i], centres[j]);
    }
  }
  // Dark module.
  setFn(g, size - 8, 8, 1);
}

/** Draw (and reserve) the 15 format-info modules for a given mask. Level L => EC indicator 01. */
function drawFormat(g: Grid, mask: number): void {
  const size = g.size;
  const data = (0b01 << 3) | mask; // level L format bits (01) ‖ mask
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412; // 15-bit format value
  // First copy: around the top-left finder — bits 0..7 down column 8, bits 8..14 along row 8.
  // (Ported from Nayuki's reference, whose setFunctionModule(x, y) takes COLUMN first — the
  // coordinates below are already transposed to this file's (row, col) convention.)
  for (let i = 0; i <= 5; i++) setFn(g, i, 8, getBit(bits, i));
  setFn(g, 7, 8, getBit(bits, 6));
  setFn(g, 8, 8, getBit(bits, 7));
  setFn(g, 8, 7, getBit(bits, 8));
  for (let i = 9; i < 15; i++) setFn(g, 8, 14 - i, getBit(bits, i));
  // Second copy: bits 0..7 along row 8 under the top-right finder (right→left), bits 8..14 down
  // column 8 beside the bottom-left finder.
  for (let i = 0; i < 8; i++) setFn(g, 8, size - 1 - i, getBit(bits, i));
  for (let i = 8; i < 15; i++) setFn(g, size - 15 + i, 8, getBit(bits, i));
  setFn(g, size - 8, 8, 1); // dark module (idempotent)
}

/** Draw (and reserve) the 18 version-info modules — versions 7..10 only. */
function drawVersion(g: Grid, version: number): void {
  if (version < 7) return;
  const size = g.size;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem; // 18-bit value
  for (let i = 0; i < 18; i++) {
    const bit = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFn(g, a, b, bit);
    setFn(g, b, a, bit);
  }
}

/** Zig-zag data placement (two columns at a time, right→left, skipping the col-6 timing line). */
function drawCodewords(g: Grid, codewords: number[]): void {
  const size = g.size;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing line is not a data column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (!g.func[row][col] && bitIndex < totalBits) {
          const bit = getBit(codewords[bitIndex >> 3], 7 - (bitIndex & 7));
          g.modules[row][col] = bit;
          bitIndex++;
        }
      }
    }
  }
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/** XOR the mask into every non-function module (self-inverse — call again to undo). */
function applyMask(g: Grid, mask: number): void {
  for (let r = 0; r < g.size; r++) {
    for (let c = 0; c < g.size; c++) {
      if (!g.func[r][c] && maskCondition(mask, r, c)) g.modules[r][c] ^= 1;
    }
  }
}

// ----- Mask-penalty scoring (ISO/IEC 18004 rules N1..N4, Nayuki formulation) ----------------------
function finderPenaltyAddHistory(runLength: number, history: number[], size: number): void {
  if (history[0] === 0) runLength += size; // add light border to the initial run
  history.pop();
  history.unshift(runLength);
}

function finderPenaltyCount(history: number[]): number {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function finderPenaltyTerminate(runColor: boolean, runLength: number, history: number[], size: number): number {
  if (runColor) {
    finderPenaltyAddHistory(runLength, history, size);
    runLength = 0;
  }
  runLength += size; // add light border to the final run
  finderPenaltyAddHistory(runLength, history, size);
  return finderPenaltyCount(history);
}

function penaltyScore(g: Grid): number {
  const size = g.size;
  const dark = (r: number, c: number) => g.modules[r][c] === 1;
  let result = 0;
  // Rows.
  for (let y = 0; y < size; y++) {
    let runColor = false, runX = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (dark(y, x) === runColor) {
        runX++;
        if (runX === 5) result += PENALTY_N1;
        else if (runX > 5) result++;
      } else {
        finderPenaltyAddHistory(runX, history, size);
        if (!runColor) result += finderPenaltyCount(history) * PENALTY_N3;
        runColor = dark(y, x);
        runX = 1;
      }
    }
    result += finderPenaltyTerminate(runColor, runX, history, size) * PENALTY_N3;
  }
  // Columns.
  for (let x = 0; x < size; x++) {
    let runColor = false, runY = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (dark(y, x) === runColor) {
        runY++;
        if (runY === 5) result += PENALTY_N1;
        else if (runY > 5) result++;
      } else {
        finderPenaltyAddHistory(runY, history, size);
        if (!runColor) result += finderPenaltyCount(history) * PENALTY_N3;
        runColor = dark(y, x);
        runY = 1;
      }
    }
    result += finderPenaltyTerminate(runColor, runY, history, size) * PENALTY_N3;
  }
  // 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = dark(y, x);
      if (color === dark(y, x + 1) && color === dark(y + 1, x) && color === dark(y + 1, x + 1)) {
        result += PENALTY_N2;
      }
    }
  }
  // Dark/light balance.
  let darkCount = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (dark(y, x)) darkCount++;
  const total = size * size;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

/** Encode `text` into a QR module grid (level L, auto version 1..10). Dark = 1. `forceMask` is a
 *  test hook to pin a specific mask; production callers omit it and let the penalty rules choose. */
export function qrGrid(text: string, forceMask?: number): Grid {
  const bytes = encoder.encode(text);
  const version = pickVersion(bytes.length);
  const codewords = interleave(buildDataCodewords(bytes, version), version);
  const g = newGrid(17 + 4 * version);
  drawFunctionPatterns(g, version);
  drawFormat(g, 0); // reserve the format area; overwritten below once the mask is chosen
  drawVersion(g, version);
  drawCodewords(g, codewords);
  // Choose the lowest-penalty mask (unless one is pinned).
  let bestMask = 0, bestPenalty = Infinity;
  if (forceMask !== undefined) {
    bestMask = forceMask;
  } else {
    for (let mask = 0; mask < 8; mask++) {
      applyMask(g, mask);
      drawFormat(g, mask);
      const penalty = penaltyScore(g);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
      applyMask(g, mask); // undo
    }
  }
  applyMask(g, bestMask);
  drawFormat(g, bestMask);
  return g;
}

/** The QR module matrix (no quiet zone) as rows of 0/1 — dark = 1. Matches the `qrcode` npm
 *  package's `create(text,{errorCorrectionLevel:'L'}).modules` grid byte-for-byte. */
export function qrMatrix(text: string): number[][] {
  return qrGrid(text).modules;
}

/** Row-major flattened matrix (dark = 1), the shape the fixture pins for an exact compare. */
export function qrModules(text: string): { size: number; data: number[] } {
  const g = qrGrid(text);
  const data: number[] = [];
  for (let r = 0; r < g.size; r++) for (let c = 0; c < g.size; c++) data.push(g.modules[r][c]);
  return { size: g.size, data };
}

/**
 * Render `text` as a QR using Unicode half-block glyphs: two matrix rows share one text line, so the
 * code stays roughly square in a terminal. A dark module becomes the filled half; light stays blank.
 * `quiet` is the light-margin width (modules) around the symbol — default 4, the ISO 18004 quiet
 * zone (required for reliable scanning; nothing beyond it — every extra module row costs terminal
 * space). Pure sequential lines — no cursor moves — so it is safe inside a non-TTY Claude Code
 * slash-command transcript.
 */
export function renderQR(text: string, quiet = 4): string {
  const g = qrGrid(text);
  const size = g.size;
  const full = size + quiet * 2;
  // Dark lookup with the quiet zone applied (out-of-symbol => light).
  const dark = (r: number, c: number): boolean => {
    const rr = r - quiet, cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return false;
    return g.modules[rr][cc] === 1;
  };
  const lines: string[] = [];
  for (let r = 0; r < full; r += 2) {
    let line = "";
    for (let c = 0; c < full; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < full ? dark(r + 1, c) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
