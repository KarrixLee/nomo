import { describe, expect, test } from "bun:test";
import { renderPairPage } from "./pair-page";
import { renderQRSVG } from "../qr/qr-svg";

const SVG = renderQRSVG("nomo://pair?v=1&p=00112233&s=AAAA");

describe("renderPairPage", () => {
  test("is a self-contained HTML document titled 'Pair with Nomo' with the inline SVG", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000 });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Pair with Nomo</title>");
    expect(html).toContain(SVG); // the QR SVG is embedded verbatim
  });

  test("no external requests: no http(s) URLs, no external src/href/fonts", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000 });
    // The only URL-ish token is the SVG namespace; nothing fetches over the network.
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/href=["']https?:/);
    expect(html).not.toContain("fonts.googleapis");
    expect(html).not.toContain("cdn");
  });

  test("shows the code prominently and bakes the expiry into the countdown", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000 });
    expect(html).toContain("7-koala-sunset-mango-river");
    expect(html).toContain("var expiresAt = 1700000600000;");
    expect(html).toContain("Expired — run /nomo-cc:pair again");
    expect(html).toContain("Enter code"); // the hint mentions the code entry path
  });

  test("supports light AND dark themes", () => {
    const html = renderPairPage({ svg: SVG, code: null, expiresAt: 1_700_000_600_000 });
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("background: #ffffff"); // the QR tile stays light even in dark mode
  });

  test("code === null hides the entire code section (QR-only page)", () => {
    const html = renderPairPage({ svg: SVG, code: null, expiresAt: 1_700_000_600_000 });
    expect(html).not.toContain("or enter the code");
    expect(html).not.toContain('class="code"');
    // still a complete page with the QR
    expect(html).toContain(SVG);
  });

  test("escapes the code before interpolation (defense in depth)", () => {
    const html = renderPairPage({ svg: SVG, code: "1-<script>-x", expiresAt: 1 });
    expect(html).toContain("1-&lt;script&gt;-x");
    expect(html).not.toContain("1-<script>-x");
  });
});
