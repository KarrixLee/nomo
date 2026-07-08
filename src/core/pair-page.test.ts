import { describe, expect, test } from "bun:test";
import { renderPairPage } from "./pair-page";
import { renderQRSVG } from "../qr/qr-svg";
import { NOMO_ICON_DATA_URI } from "./icon-data";

const SVG = renderQRSVG("nomo://pair?v=1&p=00112233&s=AAAA");
const POLL = { workerURL: "https://worker.test", pairingId: "abc123", pcSecret: "pc-secret-xyz" };

describe("renderPairPage", () => {
  test("is a self-contained HTML document titled 'Pair with Nomo' with the inline SVG", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000 });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Pair with Nomo</title>");
    expect(html).toContain(SVG); // the QR SVG is embedded verbatim
  });

  test("no external requests: no http(s) URLs (except the poll target), no external src/href/fonts", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000 });
    // No poll block here → the only URL-ish token is the SVG namespace; nothing fetches over the network.
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/href=["']https?:/);
    expect(html).not.toContain("fonts.googleapis");
    expect(html).not.toContain("cdn");
  });

  test("shows the code prominently and bakes the expiry into the countdown", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000 });
    expect(html).toContain("7-koala-sunset-mango-river");
    expect(html).toContain("var expiresAt = 1700000600000;");
    expect(html).toContain("Code expired — run /nomo-cc:pair again for a fresh one.");
    expect(html).toContain("Enter code"); // the hint mentions the code entry path
  });

  test("embeds the Nomo logo as an inlined base64 data URI overlaid on the QR (no external image)", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000 });
    expect(html).toContain(NOMO_ICON_DATA_URI); // the exact inlined data URI
    expect(html).toContain("data:image/png;base64,"); // …and it IS a data URI (nothing fetched)
    expect(html).toContain('class="logo"'); // the centred overlay tile
  });

  test("renders an icon copy button next to the code that swaps to a check on success", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000 });
    expect(html).toContain('id="copy"');
    expect(html).toContain('aria-label="Copy the code"'); // accessible label (icon-only button)
    expect(html).toContain('<rect x="9" y="9"'); // the idle clipboard SVG glyph in the markup (no external asset)
    expect(html).toContain("20 6 9 17 4 12"); // the checkmark coords, swapped in on success (embedded in the script)
    expect(html).toContain("navigator.clipboard"); // async clipboard API path
    expect(html).toContain('document.execCommand("copy")'); // legacy fallback for file:// pages
    expect(html).toContain("copyBtn.innerHTML = CHECK"); // clipboard → check feedback
  });

  test("supports light AND dark themes", () => {
    const html = renderPairPage({ svg: SVG, code: null, expiresAt: 1_700_000_600_000 });
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("background: #ffffff"); // the QR tile stays light even in dark mode
  });

  test("code === null hides the entire code section (QR-only page) but keeps the logo overlay", () => {
    const html = renderPairPage({ svg: SVG, code: null, expiresAt: 1_700_000_600_000 });
    expect(html).not.toContain("or enter the code");
    expect(html).not.toContain('class="code"');
    expect(html).not.toContain('id="copy"'); // no code → no copy button
    // still a complete page with the QR + the logo overlay
    expect(html).toContain(SVG);
    expect(html).toContain('class="logo"');
  });

  test("escapes the code before interpolation (defense in depth)", () => {
    const html = renderPairPage({ svg: SVG, code: "1-<script>-x", expiresAt: 1 });
    expect(html).toContain("1-&lt;script&gt;-x");
    expect(html).not.toContain("1-<script>-x");
  });

  describe("live-status poll (poll supplied)", () => {
    const page = () => renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1_700_000_600_000, poll: POLL });

    test("polls the worker's status route with the x-cc-auth header every 3s", () => {
      const html = page();
      expect(html).toContain('/v1/cc/pair/status?p=');
      expect(html).toContain(JSON.stringify(POLL.workerURL).replace(/</g, "\\u003c"));
      expect(html).toContain(JSON.stringify(POLL.pairingId).replace(/</g, "\\u003c"));
      expect(html).toContain(JSON.stringify(POLL.pcSecret).replace(/</g, "\\u003c"));
      expect(html).toContain('"x-cc-auth"');
      expect(html).toContain("setInterval(pollOnce, 3000)");
    });

    test("has a success (claimed) state: check + 'Paired successfully' + 'close this window'", () => {
      const html = page();
      expect(html).toContain("function paired()");
      expect(html).toContain('state === "claimed"');
      expect(html).toContain("Paired successfully");
      expect(html).toContain("You can close this window.");
      expect(html).toContain('class="check"');
    });

    test("has an expired state reached by a 404 or the countdown hitting zero", () => {
      const html = page();
      expect(html).toContain("r.status === 404");
      expect(html).toContain("Code expired — run /nomo-cc:pair again for a fresh one.");
      // network errors are swallowed (offline pages keep trying) — only 404 is terminal
      expect(html).toContain(".catch(function () {");
    });

    test("bakes the poll secrets, so the page carries them (0600 / same trust domain as config.json)", () => {
      const html = page();
      expect(html).toContain("pc-secret-xyz");
    });
  });

  test("without poll: no status fetch is emitted (static page — the countdown still runs)", () => {
    const html = renderPairPage({ svg: SVG, code: "7-koala-sunset-mango-river", expiresAt: 1 });
    expect(html).not.toContain("/v1/cc/pair/status");
    expect(html).not.toContain("function paired()");
    expect(html).toContain("function tick()"); // the countdown is always present
  });
});
