// qr-svg.ts — zero-dependency SVG renderer for the pairing QR. Companion to qr.ts's half-block
// TERMINAL renderer: this one emits a standalone .svg the pair CLI writes to disk and pops open in the
// OS image viewer (Preview / a browser), OUTSIDE the Codex/Claude TUI, where a fold-free crisp QR
// scans reliably. Same module matrix (qr.ts's qrMatrix), just a different paint target.
//
// The QR encodes the `nomo://pair` URL (the QR secret) — the caller writes the file 0600 and deletes
// it the instant pairing completes; this module only produces the string.
//
// PORTABILITY: bun AND node >= 18 (Task 2.3 bundles it) — no Bun.* APIs, pure string building.

import { qrMatrix } from "./qr";

export interface QRSVGOptions {
  /** Light-margin width in MODULES around the symbol. Default 4 = the ISO 18004 quiet zone (required
   *  for reliable scanning); the file is off-screen so nothing beyond 4 is worth the extra pixels. */
  quiet?: number;
  /** Rendered pixel size of the (square) SVG. The module grid is drawn in a viewBox and scaled to fit,
   *  so this only sets the on-screen resolution — 512 is crisp on a laptop display. */
  pixelSize?: number;
}

/**
 * Render `text` as a standalone QR SVG document: a white background (including the quiet zone) with the
 * dark modules painted as unit `<rect>`s in a black group. `shape-rendering="crispEdges"` keeps the
 * module borders hard at any scale so a phone camera reads them cleanly. Returns a complete
 * `<svg …>…</svg>` string (with the SVG namespace) — self-contained, no external refs.
 */
export function renderQRSVG(text: string, opts: QRSVGOptions = {}): string {
  const quiet = opts.quiet ?? 4;
  const pixelSize = opts.pixelSize ?? 512;
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const full = size + quiet * 2; // side length in modules, quiet zone included

  // One unit rect per dark module, offset into the quiet zone. Joined into a single <g fill="#000">.
  const rects: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === 1) {
        rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" ` +
    `viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="#ffffff"/>` +
    `<g fill="#000000">${rects.join("")}</g>` +
    `</svg>`
  );
}
