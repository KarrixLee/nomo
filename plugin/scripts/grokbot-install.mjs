#!/usr/bin/env node
// grokbot-install.mjs — get Grok Bot days onto the Nomo Activity widget when Grok Bot is your only agent.
//
//   node plugin/scripts/grokbot-install.mjs               install / refresh the hourly job
//   node plugin/scripts/grokbot-install.mjs --uninstall   unload and delete it (nothing else)
//
// WHY A LAUNCHD JOB. The activity scan (src/core/activity.ts, which reads the Grok Bot app's saved chats)
// runs inside the watchdog, and only agent hooks ever start the watchdog. Grok Bot has no hooks, so on a
// Mac with no other agent nothing would ever run it. This writes ONE per-user LaunchAgent that starts the
// EXISTING watchdog at login and once an hour:
//
//   /bin/sh <root>/scripts/run.sh <root>/dist/cc-watchdog.mjs --scheduled
//
// run.sh resolves bun/node at run time (so a version manager moving node breaks nothing) and gives bun
// `--config=/dev/null --env-file=/dev/null`. `--scheduled` makes the watchdog an ACTIVITY ONE-SHOT (see
// scheduledActivityRun): if any watchdog is already running it does nothing, otherwise it runs one
// activity scan/upload (normal gates; nothing when unpaired) and exits. It never claims the watchdog
// pidfile, serves sessions, opens the LAN listener or lingers. So: no new daemon, no new bundle.
// User-level launchd only (~/Library/LaunchAgents, `gui/<uid>`): no sudo, no LaunchDaemon.
//
// The plist addresses THIS checkout by absolute path — safe for the same reason as cursor-install.mjs:
// it runs from ~/.nomo (`bunx nomo-ai --grokbot`), a checkout that is `git pull`ed, never moved.
//
// Zero dependencies and no build step: plain node >= 18, so it runs straight out of a fresh clone.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN = join(ROOT, "scripts", "run.sh");
const WATCHDOG = join(ROOT, "dist", "cc-watchdog.mjs");
const LABEL = "gg.nomo.activity";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const INTERVAL_S = 3600;

const say = (msg) => console.log(`grokbot-install: ${msg}`);
const fail = (msg) => {
  console.error(`grokbot-install: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const UNINSTALL = args.includes("--uninstall");
for (const a of args) {
  if (a === "-h" || a === "--help") {
    console.log("usage: grokbot-install.mjs [--uninstall]");
    process.exit(0);
  }
  if (a !== "--uninstall") fail(`unknown argument: ${a}`);
}

const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>${xml(RUN)}</string>
		<string>${xml(WATCHDOG)}</string>
		<string>--scheduled</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>${INTERVAL_S}</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>Nice</key>
	<integer>10</integer>
</dict>
</plist>
`;

const domain = `gui/${process.getuid?.() ?? ""}`;
/** launchctl's exit status (0 = ok). Output is captured so "not loaded" never reads as an error. */
const launchctl = (...a) => {
  const r = spawnSync("launchctl", a, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || r.error?.message || "" };
};
const loaded = () => launchctl("print", `${domain}/${LABEL}`).ok;

if (process.platform !== "darwin") {
  if (UNINSTALL) {
    say("nothing to remove — the Grok Bot job only exists on macOS.");
    process.exit(0);
  }
  fail("Grok Bot setup is macOS only (it adds a per-user launchd job) — nothing was changed");
}

try {
  if (UNINSTALL) {
    const wasLoaded = loaded();
    const out = wasLoaded ? launchctl("bootout", `${domain}/${LABEL}`) : { ok: true, out: "" };
    const hadFile = existsSync(PLIST);
    rmSync(PLIST, { force: true });
    if (!out.ok) {
      console.error(`grokbot-install: launchctl bootout ${domain}/${LABEL} failed: ${out.out}`);
      console.error(`grokbot-install: ${hadFile ? `removed ${PLIST}; ` : ""}to stop it now: launchctl bootout ${domain}/${LABEL}`);
      process.exitCode = 1;
    } else {
      say(`job      -> ${wasLoaded ? `unloaded and removed ${PLIST}` : hadFile ? `removed ${PLIST}` : "not installed — nothing to remove"}`);
    }
    // Order does not matter: unpair needs only config.json and the plugin files, both left in place here.
    say("pairing is untouched (it is shared with your other agents) — to disconnect this Mac from your phone, run `bunx nomo-ai unpair` (before or after this).");
  } else {
    if (!existsSync(WATCHDOG)) fail(`${WATCHDOG} is missing — run 'bun build.ts' from the repo root first`);
    if (!existsSync(RUN)) fail(`${RUN} is missing — this does not look like a nomo plugin directory`);
    const want = plist();
    const same = existsSync(PLIST) && readFileSync(PLIST, "utf8") === want;
    if (same && loaded()) {
      say(`job      -> ${PLIST} (already up to date)`);
    } else {
      mkdirSync(dirname(PLIST), { recursive: true });
      const tmp = `${PLIST}.${process.pid}.tmp`;
      writeFileSync(tmp, want, { mode: 0o644 });
      renameSync(tmp, PLIST);
      // Reload so launchd reads the new file. bootout of a job that is not loaded just fails — ignored.
      // launchd can refuse a bootstrap for a moment while the old job is still exiting, so retry briefly.
      launchctl("bootout", `${domain}/${LABEL}`);
      let r = launchctl("bootstrap", domain, PLIST);
      for (let i = 0; !r.ok && i < 5; i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        r = launchctl("bootstrap", domain, PLIST);
      }
      if (!r.ok) {
        fail(`launchctl bootstrap ${domain} ${PLIST} failed: ${r.out}\n` +
          `grokbot-install: the file is in place; load it by hand with that command, or log out and back in`);
      }
      say(`job      -> ${PLIST} (loaded)`);
    }
    say(`            runs ${WATCHDOG} at login and every hour`);
    // Pairing stays a step the user runs (pairing again would replace an existing pairing).
    say("not paired yet? pair from any folder (then scan the QR):  bunx nomo-ai pair");
    say("check it works:                                          bunx nomo-ai status");
  }
} catch (e) {
  fail(`could not finish — ${e?.message ?? e}`);
}
