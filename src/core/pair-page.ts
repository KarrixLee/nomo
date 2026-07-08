// pair-page.ts — renders the self-contained HTML pairing page (pairing v2). `pair` writes this to
// ~/.config/cc-status/pair.html (0600) and opens it in the user's browser, replacing the terminal QR
// art: a themed page is where the QR and the one-time code are shown, OUTSIDE the agent TUI where a
// folded/retyped terminal QR is unreliable and where a stdout secret would land in the transcript.
//
// Single file, ZERO external requests: the QR is an inline <svg>, the styles are inline <style>, the
// countdown is inline <script>. No fonts, images, analytics, or network — it opens from a file:// URL.
//
// The page carries the SAME `nomo://pair` secret the QR always encoded (inside the SVG) plus, when the
// worker assigned a channel, the human-typeable code — so this file is written 0600 and torn down the
// instant pairing completes (completePendingPairing) / by unpair, exactly like the old pair-qr.svg.
//
// PORTABILITY: pure string building — runs unmodified under bun and node >= 18.

export interface PairPageOptions {
  /** The QR as a complete standalone `<svg …>…</svg>` string (renderQRSVG output) — embedded inline. */
  svg: string;
  /** The one-time code, `<channel>-w1-w2-w3-w4`, or null when the worker assigned no channel (old
   *  worker / QR-only). Null hides the entire code section — the page then shows the QR alone. */
  code: string | null;
  /** Epoch-ms the pairing expires (createdAt + the 10-min TTL). Baked into the countdown. */
  expiresAt: number;
}

/** Minimal HTML-escape for text interpolated into the page (the code string is `[0-9a-z-]` so this is
 *  belt-and-suspenders, but the SVG is trusted renderQRSVG output and is embedded verbatim). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render the complete pairing page as a single HTML document string. Light + dark themed
 * (prefers-color-scheme), system font stack, a white QR tile that stays light in dark mode (QRs need a
 * light background to scan), a prominent monospace code, and a live countdown that flips to an expired
 * notice at zero.
 */
export function renderPairPage(opts: PairPageOptions): string {
  const { svg, code, expiresAt } = opts;

  const codeSection = code
    ? `
      <div class="or">or enter the code</div>
      <div class="code" aria-label="one-time pairing code">${esc(code)}</div>
      <p class="hint">In the Nomo app: <b>Sessions</b> → <b>Pair a Computer</b> → scan the QR, or tap <b>“Enter code”</b>.</p>`
    : `
      <p class="hint">In the Nomo app: <b>Sessions</b> → <b>Pair a Computer</b> → point the camera at the QR.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair with Nomo</title>
<style>
  :root {
    --bg: #f4f4f5; --card: #ffffff; --fg: #18181b; --muted: #71717a;
    --border: #e4e4e7; --accent: #6366f1; --code-bg: #f4f4f5; --shadow: rgba(0,0,0,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #09090b; --card: #18181b; --fg: #fafafa; --muted: #a1a1aa;
      --border: #27272a; --accent: #818cf8; --code-bg: #27272a; --shadow: rgba(0,0,0,.5);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 20px;
    box-shadow: 0 12px 40px var(--shadow);
    padding: 40px; max-width: 400px; width: 100%; text-align: center;
  }
  h1 { font-size: 22px; font-weight: 650; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 14px; margin: 0 0 28px; }
  .qr-tile {
    background: #ffffff; border-radius: 16px; padding: 16px;
    display: inline-block; line-height: 0; box-shadow: 0 2px 10px var(--shadow);
  }
  .qr-tile svg { width: 232px; height: 232px; display: block; }
  .or {
    color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    margin: 26px 0 10px; font-weight: 600;
  }
  .code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 22px; font-weight: 600; color: var(--fg);
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 12px; word-break: break-word; line-height: 1.4;
  }
  .hint { color: var(--muted); font-size: 13px; line-height: 1.5; margin: 20px 0 0; }
  .hint b { color: var(--fg); font-weight: 600; }
  .timer {
    margin-top: 24px; font-size: 13px; color: var(--muted);
    padding-top: 20px; border-top: 1px solid var(--border);
  }
  .timer #count { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
  .timer.expired { color: #ef4444; }
  .timer.expired #count { color: #ef4444; }
</style>
</head>
<body>
  <main class="card">
    <h1>Pair with Nomo</h1>
    <p class="sub">Scan this with the Nomo app on your iPhone.</p>
    <div class="qr-tile">${svg}</div>${codeSection}
    <div class="timer" id="timer">
      Expires in <span id="count">10:00</span>
    </div>
  </main>
<script>
  (function () {
    var expiresAt = ${Math.floor(expiresAt)};
    var timer = document.getElementById("timer");
    var count = document.getElementById("count");
    function tick() {
      var ms = expiresAt - Date.now();
      if (ms <= 0) {
        timer.classList.add("expired");
        timer.textContent = "Expired — run /nomo-cc:pair again";
        clearInterval(iv);
        return;
      }
      var total = Math.floor(ms / 1000);
      var m = Math.floor(total / 60);
      var s = total % 60;
      count.textContent = m + ":" + (s < 10 ? "0" : "") + s;
    }
    var iv = setInterval(tick, 250);
    tick();
  })();
</script>
</body>
</html>
`;
}
