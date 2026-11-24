/** OpenCode 2.x remote control — the phone's Reply and Interrupt, delivered INSIDE OpenCode (2.5.3).
 *
 *  WHY FILES. The phone's commands reach this Mac at the watchdog (relay responses + the LAN listener),
 *  which authenticates them (cc-watchdog drainCommands: decrypt, allow-list, freshness, nonce, known
 *  session). The watchdog is a separate process with no way into OpenCode, and OpenCode's server need
 *  not listen on any port — but THIS plugin runs inside that server and holds the 2.x context, whose
 *  `session.prompt` / `session.interrupt` are exactly the two calls needed. So the watchdog leaves the
 *  authenticated command on disk, the way it already does for Claude Code / Antigravity / Devin:
 *
 *    Reply      `<session>.<mid>.agy-inbox` + receipt `<session>.<mid>.agy-reply`
 *               (core/antigravity-inbox.ts — the same queue, receipts and rename-claim)
 *    Interrupt  `<session>.oc-interrupt` = {"at": <epoch ms>} (shared.ts writeInterruptFlagAt)
 *
 *  and this pump picks them up once a second for the sessions this plugin instance owns.
 *
 *  ONLY ON 2.x: the 1.x entry never starts it, and the phone offers the controls only where a frame
 *  carried `controls` (see the contract doc). Never throws into OpenCode.
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ANTIGRAVITY_INBOX_SUFFIX, takeReplies, writeReceipt } from "../core/antigravity-inbox";

/** The interrupt flag's suffix — `opencodeAdapter.interruptFlagSuffix` (the watchdog writes it). */
export const OC_INTERRUPT_SUFFIX = ".oc-interrupt";
/** A flag older than this is stale intent (the command TTL, cc-watchdog COMMAND_TTL_MS): dropped unread. */
export const OC_INTERRUPT_MAX_AGE_MS = 120_000;

export interface OcRemoteDeps {
  /** The sessions directory (SESSIONS_DIR). */
  dir: string;
  /** Is this OpenCode session this plugin instance's (its location)? */
  owns: (sessionID: string) => Promise<boolean>;
  /** `ctx.session.prompt`, or undefined when this OpenCode has none (every message is refused). */
  prompt?: (input: { sessionID: string; text: string; delivery: "steer"; id: string }) => Promise<unknown>;
  /** `ctx.session.interrupt`, or undefined (flags are consumed and dropped). */
  interrupt?: (input: { sessionID: string }) => Promise<unknown>;
  /** A session's reply receipts changed — repaint its row so the phone sees them. */
  published: (sessionID: string) => void;
  trace: (event: object) => void;
  now?: () => number;
}

/** OpenCode's own message id for a phone message: deterministic, so a retried delivery of the same mid
 *  is admitted once (OpenCode reconciles a repeated id instead of adding a second message). Must start
 *  with `msg_` (schema/session-message.ts); history is ordered by `seq`, not by id. */
export const ocMessageId = (mid: string): string => `msg_nomo_${mid}`;

/** OpenCode session ids start with `ses` (schema/session-id.ts) — the cheap filter that keeps every
 *  Antigravity / Claude file in the shared directory out of the ownership lookup. */
const isOcSession = (id: string): boolean => id.startsWith("ses");

/** One pass: every owned session's interrupt flag, then its queued messages. */
export async function ocRemoteTick(d: OcRemoteDeps): Promise<void> {
  let names: string[];
  try { names = await readdir(d.dir); } catch { return; }
  const now = (d.now ?? Date.now)();
  const flags = new Set<string>();
  const inboxes = new Set<string>();
  for (const n of names) {
    if (n.endsWith(OC_INTERRUPT_SUFFIX)) flags.add(n.slice(0, -OC_INTERRUPT_SUFFIX.length));
    else if (n.endsWith(ANTIGRAVITY_INBOX_SUFFIX)) inboxes.add(n.slice(0, n.indexOf(".")));
  }
  for (const sessionID of flags) {
    if (!isOcSession(sessionID) || !await d.owns(sessionID)) continue;
    const path = join(d.dir, `${sessionID}${OC_INTERRUPT_SUFFIX}`);
    let at = 0;
    try { at = Number((JSON.parse(await readFile(path, "utf8")) as { at?: unknown }).at); } catch { /* unreadable → stale */ }
    // Consume BEFORE acting: a throw mid-interrupt must never re-fire it on the next tick.
    try { await unlink(path); } catch { continue; } // another instance took it
    if (!(now - at <= OC_INTERRUPT_MAX_AGE_MS) || !d.interrupt) {
      d.trace({ event: "oc-interrupt", sessionId: sessionID, result: d.interrupt ? "stale" : "unsupported" });
      continue;
    }
    try {
      const out = await d.interrupt({ sessionID }) as { interrupted?: unknown } | undefined;
      d.trace({ event: "oc-interrupt", sessionId: sessionID, result: out?.interrupted === true ? "interrupted" : "not-running" });
    } catch (e) {
      d.trace({ event: "oc-interrupt", sessionId: sessionID, result: "failed", error: (e as { name?: string })?.name ?? "Error" });
    }
  }
  for (const sessionID of inboxes) {
    if (!isOcSession(sessionID) || !await d.owns(sessionID)) continue;
    const replies = await takeReplies(d.dir, sessionID);
    if (replies.length === 0) continue;
    for (const r of replies) {
      let receipt: "d" | "x" = "x";
      if (d.prompt) {
        try {
          // `steer`: before the agent's next model call even mid-turn; on an idle session it starts one.
          await d.prompt({ sessionID, text: r.text, delivery: "steer", id: ocMessageId(r.mid) });
          receipt = "d";
        } catch (e) {
          // A conflict on OUR deterministic id means this very message was admitted already.
          const name = String((e as { name?: unknown; _tag?: unknown })?._tag ?? (e as { name?: unknown })?.name ?? "");
          if (/Conflict/.test(name)) receipt = "d";
          d.trace({ event: "reply", sessionId: sessionID, agent: "opencode", result: receipt === "d" ? "duplicate" : "failed", error: name || "Error" });
        }
      }
      await writeReceipt(d.dir, sessionID, r.mid, receipt);
      if (receipt === "d") d.trace({ event: "reply", sessionId: sessionID, agent: "opencode", result: "delivered", mid: r.mid });
    }
    d.published(sessionID);
  }
}

/** Run ocRemoteTick every `intervalMs` (never overlapping), unref'd. Returns `stop`. */
export function ocWatchRemote(d: OcRemoteDeps, intervalMs = 1000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void ocRemoteTick(d).catch(() => {}).finally(() => { running = false; });
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
