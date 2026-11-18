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
| Process tree | `devin -p …` → `devin acp` → hook. A single-command hook string is exec'd (the hook's parent is `devin acp`), so `run.sh` → `exec node` makes node the direct child, which then dies without cleanup. The approval command therefore ends in `; exit 0` so the shell stays as the parent and node sees its ppid change. Confirmed in the P6 end-to-end run: Devin runs the command with `bash -c`, and the bundle's parent is that `bash`, whose parent is `devin acp`. |
| `ownerExe` | basename `devin` (`~/.local/bin/devin`, a symlink into `_versions/<v>/bin/devin`); the nearest one is `devin acp`. |
| `toolInputKeys` | `exec` → `command`; `write` → `file_path`, `content`. `edit`/`apply_patch` were not exercised (the model used `write`); the binary's `EditInput` names `file_path`, `old_string`, `new_string`, `replace_all`. A read-only `exec` (`echo`) raised no PermissionRequest. |
| Payload keys | all: `hook_event_name`, `session_id` (word-word slug), `prompt_id` (absent on SessionStart). Tool events add `tool_name`, `tool_input`, `tool_use_id` (+ `tool_response` on PostToolUse). `UserPromptSubmit`: `prompt`. `Stop`: `stop_hook_active`, `last_assistant_message`. `SessionEnd`: `reason` (`"other"`). **No `cwd`, no `transcript_path`.** PermissionRequest fires after PreToolUse for the same call. |
| Env | `DEVIN_PROJECT_DIR` **and `CLAUDE_PROJECT_DIR`** are both set for every hook. |
| `titleAtStop` | Yes: `sessions.title` was Devin's AI title ("Create spike3.txt") when `Stop` fired; `model` was still `""` at Stop and filled (`swe-2-flash-medium`) by SessionEnd. A run that ended without Stop had the truncated first prompt as its title at SessionEnd. |
| `askHooks` | Not observed: `ask_user_question` could not be triggered in `-p`. The PreToolUse heads-up stays unverified (device checklist). |

Not drivable from an agent: does the interactive TUI draw its own prompt while a PermissionRequest hook
holds, and does Devin Desktop fire the same hooks. Both are on the device checklist.

## Addendum — advanced controls spike (same day, same CLI)

Ten more runs in throwaway projects (`.devin/hooks.v1.json` with every event, `read_config_from` all
false, `NOMO_CC_DIR` throwaway), sessions deleted after. What shipped from it in plugin 2.5.0:

| Finding | Result |
|---|---|
| Rule written mid-session (Always allow) | A hook that approved and wrote `.devin/config.local.json` = `{"permissions":{"allow":["Exec(touch)"]}}` did **not** stop the next `touch` in the same session from raising PermissionRequest; the next session honoured it (`touch` ran unasked, `mkdir` still asked). Config is read at session start. The binary has no `updatedPermissions`: its Claude-compatible output is `{continue, stopReason, suppressOutput, decision, reason, systemMessage, hookSpecificOutput}`. ⇒ Always allow is a Nomo-side per-session grant (`core/devin-approval.ts`). |
| Interrupt | PostToolUse printing `{"stop":"…"}` is **ignored**. PostToolUse printing `{"continue":false,"stopReason":"Interrupted from Nomo"}` ends the turn right after that tool: `devin -p` prints `Hook stop: Interrupted from Nomo` / `Error: Operation canceled by user` (exit 1), **no Stop**, SessionEnd fires (because `-p` exits). `devin -r <id> -p …` resumes with full context; the model never sees the stop reason. Unverified: whether PostToolUse fires for a tool that failed (Devin has no PostToolUseFailure). |
| ACP = the Desktop transport | `devin acp` over stdio with a hand-written client (`elicitation: {form: {}}`): the same hooks with the same payloads (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, SessionEnd); `exec`'s `tool_input` gains `workdir`. `session/new` starts in mode `accept-edits` ("Code"). |
| Permission order under ACP | **Hook first, client second.** A hook that approved after 6 s: the client never got `session/request_permission`. A hook that printed nothing: the client then got it, with options `allow_once`, `allow_session` ("Yes, allow `touch` commands (this session)"), `allow_always`, `allow_always_global`, `switch_bypass`, `reject_once` and `_meta."cognition.ai/permissionRule": "Exec(touch)"`. ⇒ While Nomo holds, Desktop shows no buttons. |
| `ask_user_question` | Fires **PreToolUse, never PermissionRequest**. `tool_input` = `{"questions":[{"question","header","options":[{"label","description"?}],"multi_select"?}]}`. Then the client gets `elicitation/create` (form, `q0` with `oneOf` labels, `_meta."cognition.ai/allowOther": true`); cancelling it ⇒ `Tool execution was rejected: User canceled the question`. |
| `updatedInput.answers` | Schema text: "User's answers, keyed by question text. Populated by the UI … Do not set this yourself"; each value `UserQuestionAnswer {selected: [labels], custom_text}`. An array fails validation (`expected field 'answers' to be object, got array`). The correct object validated and was **ignored**: Devin still sent `elicitation/create`. |
| Block-with-answer | PreToolUse printing `{"decision":"block","reason":"The user already answered this from their phone (Nomo): \"Which color do you prefer?\" -> Blue. …"}`: no elicitation, the model ran `echo Blue > color.txt` and replied `Blue`. The client sees a failed tool call `Tool rejected: <reason>` and an agent chunk `Hook block: <hook command>`. ⇒ the shipped question answer. |
| Desktop's devin | Devin Desktop bundles its own `devin` (3000.11.238) at `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`. The GUI itself was not driven: device checklist. |

Wire Nomo ships on these (plugin 2.5.0): `{"continue":false,"stopReason":"Interrupted from Nomo"}` from
PostToolUse while `<sessions>/<id>.interrupt` is fresh; `{"decision":"approve"}` for a stored
`<sessions>/<id>.devin-allow` grant; `{"decision":"block","reason":"The user answered from their phone
(Nomo): …"}` from PreToolUse `ask_user_question` for a phone answer.
