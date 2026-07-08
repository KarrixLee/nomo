// pair-page.ts — renders the self-contained HTML pairing page (pairing v2). `pair` writes this to
// ~/.config/cc-status/pair.html (0600) and opens it in the user's browser, replacing the terminal QR
// art: a themed page is where the QR and the one-time code are shown, OUTSIDE the agent TUI where a
// folded/retyped terminal QR is unreliable and where a stdout secret would land in the transcript.
//
// Single file, ZERO external requests: the QR is an inline <svg>, the Nomo logo is an inlined base64
// data URI (icon-data.ts), the styles are inline <style>, the countdown + live-status poll are inline
// <script>. No fonts, remote images, analytics, or CDN — it opens from a file:// URL.
//
// The page carries the SAME `nomo://pair` secret the QR always encoded (inside the SVG) plus, when the
// worker assigned a channel, the human-typeable code, PLUS (for the live-status poll) the workerURL +
// pairingId + pcSecret — so this file is written 0600 (same trust domain as config.json, which already
// stores pcSecret) and torn down the instant pairing completes (completePendingPairing) / by unpair.
//
// PORTABILITY: pure string building — runs unmodified under bun and node >= 18.

import { NOMO_ICON_DATA_URI } from "./icon-data";

// Inline (no external assets) copy-button icons: a clipboard (idle) that swaps to a checkmark on a
// successful copy. `currentColor` inherits the button's white text so both themes get a white glyph.
const CLIPBOARD_ICON =
  '<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
  '<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="20 6 9 17 4 12"/></svg>';

export interface PairPageOptions {
  /** The QR as a complete standalone `<svg …>…</svg>` string (renderQRSVG output) — embedded inline.
   *  The page overlays the Nomo logo dead-centre; the logo is sized to stay within the QR's error
   *  budget so it still scans (the WhatsApp/WeChat pattern). Since the pairing-v3 payload carries the
   *  PC ephemeral key (`e=`) it exceeds level-Q capacity and renders at level L (~7% recovery), so the
   *  logo footprint is kept to ~4% of the symbol area — comfortably under L's budget with margin. */
  svg: string;
  /** The one-time code, `<channel>-w1-w2-w3-w4`, or null when the worker assigned no channel (old
   *  worker / QR-only). Null hides the entire code section — the page then shows the QR alone. */
  code: string | null;
  /** Epoch-ms the pairing expires (createdAt + the 10-min TTL). Baked into the countdown. */
  expiresAt: number;
  /** Live-status poll parameters. When present, the page polls the worker every 3s and flips itself to
   *  a success state on claim (or an expired state on 404 / countdown-zero). Absent → a static page
   *  (the countdown still runs) — used by pure-render tests without a worker to poll. */
  poll?: {
    /** The worker base URL (no trailing slash) the page polls; must serve CORS for /v1/cc/pair/status. */
    workerURL: string;
    /** The pairing id (hex) — the `?p=` query param. */
    pairingId: string;
    /** The pc secret — sent as the `x-cc-auth` header, exactly like the `pair wait` CLI poll. Same trust
     *  domain as config.json (which stores it); the page is 0600 and deleted on completion/unpair. */
    pcSecret: string;
  };
}

/** Minimal HTML-escape for text interpolated into the page (the code string is `[0-9a-z-]` so this is
 *  belt-and-suspenders, but the SVG is trusted renderQRSVG output and is embedded verbatim). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON-encode a string for safe embedding inside a `<script>` literal (escapes quotes, backslashes,
 *  and — critically — any `</script` so a value can't break out of the script element). */
function jsStr(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}

/**
 * Render the complete pairing page as a single HTML document string. Light + dark themed
 * (prefers-color-scheme), system font stack, a white QR tile that stays light in dark mode (QRs need a
 * light background to scan) with the Nomo logo overlaid dead-centre, a prominent monospace code with a
 * copy button, a live countdown, and — when `poll` is supplied — a live status poll that flips the card
 * to a "Paired ✓" success state on claim or an "expired" notice on timeout.
 */
export function renderPairPage(opts: PairPageOptions): string {
  const { svg, code, expiresAt, poll } = opts;

  // The code is click-to-reveal: blurred behind a "Tap to reveal code" button until the user clicks it,
  // so a shoulder-surfed screen or a screen-share doesn't leak it for free. It's a real <button> (not a
  // bare div) so it's keyboard-reachable and operable with Enter/Space, same as the copy button next to
  // it. The code text is still present in the DOM (this page already carries pcSecret in its poll
  // script — the blur is a screen-privacy measure, not a DOM-secrecy one); toggling just adds/removes a
  // CSS blur filter and flips the button's label + `aria-expanded`.
  const codeSection = code
    ? `
      <div class="or">or enter the code</div>
      <div class="code-row">
        <span class="code code-hidden" id="code" aria-label="one-time pairing code (hidden)">${esc(code)}</span>
        <button class="copy" id="copy" type="button" aria-label="Copy the code" title="Copy the code">${CLIPBOARD_ICON}</button>
      </div>
      <button class="reveal" id="reveal" type="button" aria-expanded="false" aria-controls="code">Tap to reveal code</button>
      <p class="hint">In the Nomo app: <b>Sessions</b> → <b>Pair a Computer</b> → scan the QR, or tap <b>“Enter code”</b>.</p>`
    : `
      <p class="hint">In the Nomo app: <b>Sessions</b> → <b>Pair a Computer</b> → point the camera at the QR.</p>`;

  // The live-status poll block (only when the worker/pairing/secret are supplied). It polls
  // GET {workerURL}/v1/cc/pair/status?p={pairingId} with the x-cc-auth header every 3s: a "claimed"
  // state swaps the card to success; a 404 (or the countdown hitting zero) swaps it to expired. Network
  // errors are swallowed (an offline page keeps trying quietly). The worker serves CORS for this route.
  const pollScript = poll
    ? `
    polling = true;
    var poll = {
      url: ${jsStr(poll.workerURL)} + "/v1/cc/pair/status?p=" + ${jsStr(poll.pairingId)},
      auth: ${jsStr(poll.pcSecret)}
    };
    // state "claimed" → swap the whole card to a success state; stop polling + the countdown, and drop
    // the QR/code with it (the secrets are no longer needed on screen).
    function paired() {
      if (!polling) return;
      polling = false;
      if (pollIv) clearInterval(pollIv);
      clearInterval(iv);
      var card = document.getElementById("card");
      card.classList.add("done");
      card.innerHTML =
        '<div class="check" aria-hidden="true">✓</div>' +
        '<h1>Paired successfully</h1>' +
        '<p class="sub">You can close this window.</p>';
    }
    // GET {workerURL}/v1/cc/pair/status?p={pairingId} with the x-cc-auth header (worker serves CORS for
    // this route). 404 → the pending record is gone (expired) → expire(). Network / CORS blips are
    // swallowed so an offline page keeps trying quietly; only a 404 is terminal.
    function pollOnce() {
      if (!polling) return;
      fetch(poll.url, { headers: { "x-cc-auth": poll.auth }, cache: "no-store" })
        .then(function (r) {
          if (r.status === 404) { expire(); return null; }
          if (!r.ok) return null; // transient server hiccup — keep polling
          return r.json();
        })
        .then(function (body) { if (body && body.state === "claimed") paired(); })
        .catch(function () { /* offline / CORS blip — keep trying quietly */ });
    }
    pollIv = setInterval(pollOnce, 3000);
    pollOnce();`
    : "";

  // Strict CSP (defense-in-depth): the page is a single self-contained file with ZERO external assets,
  // so lock it down to inline-only. connect-src MUST include the worker origin — the live-status poll
  // fetches {workerURL}/v1/cc/pair/status, and default-src 'none' would otherwise block it (and break
  // the auto-flip to "Paired ✓"). img-src data: covers the inlined Nomo logo data URI; script/style
  // 'unsafe-inline' cover the one inline <script>/<style>. No poll → connect-src 'none'.
  const workerOrigin = poll ? new URL(poll.workerURL).origin : null;
  const csp =
    `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ` +
    `img-src data:; connect-src ${workerOrigin ?? "'none'"}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair with Nomo</title>
<style>
  :root {
    --bg: #f4f4f5; --card: #ffffff; --fg: #18181b; --muted: #71717a;
    --border: #e4e4e7; --accent: #6366f1; --code-bg: #f4f4f5; --shadow: rgba(0,0,0,.08);
    --ok: #16a34a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #09090b; --card: #18181b; --fg: #fafafa; --muted: #a1a1aa;
      --border: #27272a; --accent: #818cf8; --code-bg: #27272a; --shadow: rgba(0,0,0,.5);
      --ok: #22c55e;
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
    position: relative;
    background: #ffffff; border-radius: 16px; padding: 16px;
    display: inline-block; line-height: 0; box-shadow: 0 2px 10px var(--shadow);
  }
  .qr-tile svg { width: 232px; height: 232px; display: block; }
  /* Nomo logo overlaid dead-centre on a rounded white tile. The pairing-v3 QR renders at EC level L
     (~7% recovery — the e= ephemeral key pushes it past level-Q capacity), so the tile + its white
     halo are kept to ~46px on the 232px symbol (~4% of the area), safely inside L's budget with margin. */
  .logo {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: 42px; height: 42px; border-radius: 10px; background: #ffffff;
    box-shadow: 0 0 0 2px #ffffff, 0 1px 4px rgba(0,0,0,.18);
    display: flex; align-items: center; justify-content: center; line-height: 0;
  }
  .logo img { width: 32px; height: 32px; border-radius: 8px; display: block; }
  .or {
    color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    margin: 26px 0 10px; font-weight: 600;
  }
  .code-row { display: flex; align-items: stretch; gap: 8px; }
  .code {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 19px; font-weight: 600; color: var(--fg);
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 12px;
    padding: 12px 12px; word-break: break-word; line-height: 1.35;
    display: flex; align-items: center; justify-content: center; text-align: center;
  }
  .copy {
    flex: 0 0 auto; cursor: pointer; color: #ffffff;
    background: var(--accent); border: none; border-radius: 12px;
    width: 48px; display: flex; align-items: center; justify-content: center;
    transition: background .15s, opacity .15s;
  }
  .copy:hover { opacity: .92; }
  .copy.copied { background: var(--ok); }
  .copy .ic { display: block; }
  /* Click-to-reveal: the code is blurred + unselectable until "Tap to reveal code" is pressed. */
  .code.code-hidden { filter: blur(7px); user-select: none; }
  .reveal {
    display: block; width: 100%; margin: 10px 0 0; padding: 9px 12px;
    font-size: 13px; font-weight: 600; color: var(--accent);
    background: transparent; border: 1px dashed var(--border); border-radius: 10px; cursor: pointer;
  }
  .reveal:hover { background: var(--code-bg); }
  .hint { color: var(--muted); font-size: 13px; line-height: 1.5; margin: 20px 0 0; }
  .hint b { color: var(--fg); font-weight: 600; }
  .timer {
    margin-top: 24px; font-size: 13px; color: var(--muted);
    padding-top: 20px; border-top: 1px solid var(--border);
  }
  .timer #count { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
  .timer.expired { color: #ef4444; }
  .timer.expired #count { color: #ef4444; }
  /* Success state (swapped in on claim). */
  .card.done { padding-top: 48px; padding-bottom: 48px; }
  .check {
    width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 50%;
    background: var(--ok); color: #ffffff; font-size: 40px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; line-height: 0;
  }
</style>
</head>
<body>
  <main class="card" id="card">
    <h1>Pair with Nomo</h1>
    <p class="sub">Scan this with the Nomo app on your iPhone.</p>
    <div class="qr-tile" id="qr-wrap">${svg}<div class="logo"><img src="${NOMO_ICON_DATA_URI}" alt="Nomo"></div></div>
    <div id="code-block">${codeSection}
    </div>
    <div class="timer" id="timer">
      Expires in <span id="count">10:00</span>
    </div>
  </main>
<script>
  (function () {
    var expiresAt = ${Math.floor(expiresAt)};
    var timer = document.getElementById("timer");
    var count = document.getElementById("count");
    var pollIv = null;   // the poll interval handle (set by the poll block below, if any)
    var polling = false; // true only while the poll block is actively polling

    // Expired state: the countdown hit zero OR the poll saw a 404. Stop everything and hide the QR +
    // code (the secrets are dead). Defined once here so it's safe with OR without the poll block.
    function expire() {
      polling = false;
      if (pollIv) clearInterval(pollIv);
      clearInterval(iv);
      var qr = document.getElementById("qr-wrap"); if (qr) qr.style.display = "none";
      var cb = document.getElementById("code-block"); if (cb) cb.style.display = "none";
      timer.classList.add("expired");
      timer.textContent = "Code expired — run /nomo-cc:pair again for a fresh one.";
    }
    function tick() {
      var ms = expiresAt - Date.now();
      if (ms <= 0) {
        clearInterval(iv);
        expire();
        return;
      }
      var total = Math.floor(ms / 1000);
      var m = Math.floor(total / 60);
      var s = total % 60;
      count.textContent = m + ":" + (s < 10 ? "0" : "") + s;
    }

    // Click-to-reveal: the code starts blurred; pressing the button toggles the blur + swaps its own
    // label ("Tap to reveal code" ↔ "Tap to hide code") and aria-expanded, so a screen-shared window
    // doesn't show the code by default. Keyboard-operable — it's a real <button>.
    var revealBtn = document.getElementById("reveal");
    var codeEl = document.getElementById("code");
    if (revealBtn && codeEl) {
      revealBtn.addEventListener("click", function () {
        var hidden = codeEl.classList.toggle("code-hidden");
        revealBtn.textContent = hidden ? "Tap to reveal code" : "Tap to hide code";
        revealBtn.setAttribute("aria-expanded", hidden ? "false" : "true");
        codeEl.setAttribute("aria-label", hidden ? "one-time pairing code (hidden)" : "one-time pairing code");
      });
    }

    // Copy button: clipboard API first (best-effort), execCommand fallback (file:// pages may block the
    // async clipboard API). Flashes "Copied ✓" for ~1.5s.
    var copyBtn = document.getElementById("copy");
    var codeEl = document.getElementById("code");
    if (copyBtn && codeEl) {
      var CLIP = copyBtn.innerHTML;           // the idle clipboard glyph (as rendered)
      var CHECK = ${jsStr(CHECK_ICON)};       // swapped in on a successful copy
      copyBtn.addEventListener("click", function () {
        var text = codeEl.textContent || "";
        var done = function () {
          copyBtn.classList.add("copied");
          copyBtn.innerHTML = CHECK;          // clipboard → checkmark feedback
          copyBtn.setAttribute("aria-label", "Copied");
          setTimeout(function () {
            copyBtn.classList.remove("copied");
            copyBtn.innerHTML = CLIP;
            copyBtn.setAttribute("aria-label", "Copy the code");
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
        } else {
          legacyCopy(text, done);
        }
      });
    }
    function legacyCopy(text, done) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      } catch (e) { /* clipboard unavailable — the code is still visible to type */ }
    }
    ${pollScript}

    var iv = setInterval(tick, 250);
    tick();
  })();
</script>
</body>
</html>
`;
}
