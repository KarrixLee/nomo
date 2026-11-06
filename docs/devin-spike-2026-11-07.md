# Devin hook spike (NOM-158, P0) — 2026-11-07

Devin CLI 3000.11.234, macOS, `devin --respect-workspace-trust=false -p "…"`, Free plan. Five runs, each in
a throwaway project with a project-level `.devin/hooks.v1.json` (plus `read_config_from.claude: false`
so no `~/.claude` hook fired), `NOMO_CC_DIR` pointed at the throwaway dir. Hooks logged key names and
process ancestry only.

Note: `--respect-workspace-trust false` (space) is parsed as a PATH and the run refuses; use
`--respect-workspace-trust=false`.

| Finding | Result |
|---|---|
| `T` (largest honored timeout) | `"timeout": 86400` accepted: a PermissionRequest hook held **610 s**, then printed `{"decision":"approve"}`; the write ran, `Stop` fired. No ceiling found below that. |
| `failOpen` | A timeout prints `Hook failed: … Command timed out after 5s` and counts as **no opinion**. In `-p` a no-opinion permission means the tool is **rejected and the whole run ends** (`warning: rejected a tool call that requires confirmation…`, exit 0): no `Stop`, only `SessionEnd`. Same as a hook that prints nothing. |
| `abandonSignal` | **SIGKILL to the hook's direct child only** — no catchable signal (TERM/INT/HUP traps never ran). A grandchild survives and is reparented to pid 1 at the moment of the kill. SIGINT to `devin -p` (Ctrl-C) killed the hook the same way, then `SessionEnd` fired. |
| Process tree | `devin -p …` → `devin acp` → hook. A single-command hook string is exec'd (the hook's parent is `devin acp`), so `run.sh` → `exec node` makes node the direct child, which then dies without cleanup. The approval command therefore ends in `; exit 0` so the shell stays as the parent and node sees its ppid change. |
| `ownerExe` | basename `devin` (`~/.local/bin/devin`, a symlink into `_versions/<v>/bin/devin`); the nearest one is `devin acp`. |
| `toolInputKeys` | `exec` → `command`; `write` → `file_path`, `content`. `edit`/`apply_patch` were not exercised (the model used `write`); the binary's `EditInput` names `file_path`, `old_string`, `new_string`, `replace_all`. A read-only `exec` (`echo`) raised no PermissionRequest. |
| Payload keys | all: `hook_event_name`, `session_id` (word-word slug), `prompt_id` (absent on SessionStart). Tool events add `tool_name`, `tool_input`, `tool_use_id` (+ `tool_response` on PostToolUse). `UserPromptSubmit`: `prompt`. `Stop`: `stop_hook_active`, `last_assistant_message`. `SessionEnd`: `reason` (`"other"`). **No `cwd`, no `transcript_path`.** PermissionRequest fires after PreToolUse for the same call. |
| Env | `DEVIN_PROJECT_DIR` **and `CLAUDE_PROJECT_DIR`** are both set for every hook. |
| `titleAtStop` | Yes: `sessions.title` was Devin's AI title ("Create spike3.txt") when `Stop` fired; `model` was still `""` at Stop and filled (`swe-2-flash-medium`) by SessionEnd. A run that ended without Stop had the truncated first prompt as its title at SessionEnd. |
| `askHooks` | Not observed: `ask_user_question` could not be triggered in `-p`. The PreToolUse heads-up stays unverified (device checklist). |

Not drivable from an agent: does the interactive TUI draw its own prompt while a PermissionRequest hook
holds, and does Devin Desktop fire the same hooks. Both are on the device checklist.
