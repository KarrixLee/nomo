import { describe, expect, test } from "bun:test";
import fixtures from "./qr-fixtures.json";
import { qrModules } from "./qr";
import { renderQRSVG } from "./qr-svg";

// The SVG renderer paints qr.ts's module matrix (pinned byte-for-byte against qrcode@1.5.4 in
// qr.test.ts) into a standalone document. These assertions are STRUCTURAL — geometry derived from that
// already-pinned matrix — so they stay stable without a second golden blob to maintain.

const { text, size, data } = (fixtures as Record<string, { text: string; size: number; data: string }>).pairUrl;
const DARK_MODULES = data.split("").filter((b) => b === "1").length;

describe("renderQRSVG", () => {
  test("is a standalone <svg> document with the SVG namespace", () => {
    const svg = renderQRSVG(text);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  test("viewBox spans the matrix size plus a 4-module quiet zone on every side (default)", () => {
    const { size: matrixSize } = qrModules(text);
    expect(matrixSize).toBe(size);
    const full = size + 4 * 2;
    expect(renderQRSVG(text)).toContain(`viewBox="0 0 ${full} ${full}"`);
  });

  test("a custom quiet zone widens the viewBox accordingly", () => {
    const full = size + 6 * 2;
    expect(renderQRSVG(text, { quiet: 6 })).toContain(`viewBox="0 0 ${full} ${full}"`);
  });

  test("pixelSize sets the rendered width/height (default 512)", () => {
    expect(renderQRSVG(text)).toContain('width="512" height="512"');
    expect(renderQRSVG(text, { pixelSize: 1024 })).toContain('width="1024" height="1024"');
  });

  test("paints exactly one <rect> per dark module, plus the one white background rect", () => {
    const svg = renderQRSVG(text);
    const rects = svg.match(/<rect/g) ?? [];
    expect(rects.length).toBe(DARK_MODULES + 1); // dark modules + the background fill
    expect(svg).toContain('fill="#ffffff"'); // white background (quiet zone included)
    expect(svg).toContain('fill="#000000"'); // black module group
  });

  test("dark modules are offset into the quiet zone (no module sits at x/y 0)", () => {
    // With a 4-module quiet zone the first paintable coordinate is 4; nothing lands at the origin.
    expect(renderQRSVG(text)).not.toContain('<rect x="0" y="0" width="1" height="1"/>');
  });

  test("deterministic — the same input renders byte-identically", () => {
    expect(renderQRSVG(text)).toBe(renderQRSVG(text));
  });
});
