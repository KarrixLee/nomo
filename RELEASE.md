# Releasing `nomo-ai` to npm

Plan, not pipeline. Nothing here has been built yet. Written on branch `feat/nomo-ai-release`;
verified against the tree at `bbeecf6`, npm 11.19.0 / bun 1.3.14 / node 26.7.0.

Lives at the repo root next to `README.md` and `LICENSE` because there is no `docs/` directory and
one file does not justify inventing one. README's `### Releasing` section should eventually be
three lines that link here.

---

## 1. State of play (verified, not assumed)

| Fact | Evidence |
|---|---|
| `nomo-ai` is free on npm | `registry.npmjs.org/nomo-ai` → 404. `nomo` → 200 (taken) |
| No npm session on this machine | `npm whoami` → `ENEEDAUTH`; no `~/.npmrc` |
| Tarball is 4 files / 15.2 kB | `npm pack --dry-run`: `LICENSE`, `README.md`, `bin/nomo-ai.mjs`, `package.json` |
| `bin/nomo-ai.mjs` is mode `100755` | `git ls-tree HEAD bin/` |
| All five manifests agree at `2.1.7` | grepped; `bun build.ts` enforces it |
| **`main` is at `2.1.0` and has no OpenCode support at all** | `git show origin/main:.claude-plugin/marketplace.json`; `origin/main` has no `plugin/scripts/opencode-install.sh` and no `plugin/dist/opencode.js` |
| This branch is 11 commits ahead of `main`, 11 ahead of `dev`; `dev` is fully contained in it | `git rev-list --count` |
| `main`'s tip `06dfc5e` is a merge commit whose second parent is `dev`'s tip | `git rev-list --parents -n1` |

### The failure that ships if we publish today

`bunx nomo-ai` drives every leg off `main`, because that is the repo's default branch:

- **Claude Code** — `claude plugin marketplace add KarrixLee/nomo` reads `main`'s
  `.claude-plugin/marketplace.json` → installs **2.1.0**.
- **Codex** — same via `.agents/plugins/marketplace.json` → installs **2.1.0**.
- **OpenCode** — clones `main` to `~/.nomo`, then hits the installer's own guard at
  `bin/nomo-ai.mjs:196`:
  `~/.nomo/plugin/scripts/opencode-install.sh is missing from the checkout` /
  *"Delete `~/.nomo` and re-run."*
  The hint is a **loop**: re-running clones `main` again and fails identically. OpenCode support
  does not exist on `main`.

So the OpenCode leg is not degraded, it is permanently broken with misleading advice, and the other
two silently install seven patch versions of stale plugin.

---

## 2. Decisions

### D1 — Ordering. Merge first, publish second. Non-negotiable.

"Ready to publish" means all of this is true, in order:

1. `feat/nomo-ai-release` is merged to `main` (via `dev` if you want the usual path — `dev` is a
   strict ancestor here, so `dev` fast-forwards).
2. `origin/main` contains `plugin/scripts/opencode-install.sh`, `plugin/dist/opencode.js`, and
   `2.1.7` in all four plugin manifests.
3. A `v2.1.7` tag exists on that `main` commit (annotated, matching `v2.1.0`'s style).
4. `bunx nomo-ai@next` (see D5) drives all three legs green **from that `main`** on a machine where
   `~/.nomo` does not exist.

Only then does `latest` move. Publishing before step 2 cannot be walked back — see D5.

```sh
git checkout dev && git merge --ff-only feat/nomo-ai-release && git push origin dev
git checkout main && git merge dev && git push origin main
git tag -a v2.1.7 -m "v2.1.7 — bunx nomo-ai" && git push origin v2.1.7
git checkout dev   # do not leave the shell on main
```

> `gh pr merge` switches the working branch out from under you — check
> `git branch --show-current` after any PR merge.

### D2 — Version coupling. **Decouple.** Drop `package.json` from `VERSION_MANIFESTS`.

`build.ts:36` makes `package.json` the fifth cross-checked manifest. Recommendation: remove that
row and let `package.json` move only when `bin/nomo-ai.mjs` changes.

Why, concretely:

- **The coupling makes a promise the registry cannot keep.** `bunx` resolves `nomo-ai@latest` at run
  time; the installer clones `main` at run time. Two independently moving pointers stay in lockstep
  only if an npm publish is welded to every merge — and the window between "merged to `main`" and
  "published to npm" always exists. Inside that window the number is wrong in the *worst* direction:
  a user quotes `nomo-ai 2.1.7` in a bug report while actually running plugin 2.1.8 off `main`. A
  version that is right 95% of the time is worse for diagnosis than one that never claimed to be the
  plugin's version.
- **The installer ships no plugin code.** Its version answers "which bootstrapper ran", which is all
  a bug report about the *installer* needs. Plugin bugs already have a trustworthy number: `build.ts`
  injects `__NOMO_VERSION__` into every bundle and it goes out in the `x-cc-version` header. That is
  the number to quote, and it is derived from the manifest that actually installed.
- **The coupling costs permanent registry versions.** `2.1.1 → 2.1.7` was seven bumps in days, none
  of which touched a byte of `bin/`. Under the coupling that is seven npm versions that can never be
  removed (D5), each one a `latest` the user must remember to move.
- **Decoupling costs one line** in `build.ts` and turns README's "five manifests" back into four.

Follow-up worth doing in the same pass (installer change, so not now): make the banner and
`--version` say what they install, e.g. `nomo-ai 1.0.0 — installs nomo from main`. That removes the
last reason anyone would read the installer version as a plugin version.

If you keep the coupling anyway, then publishing is no longer optional per release and this document
becomes a mandatory step in *every* plugin bump. Decide before writing any release script — the two
answers produce different scripts.

**Version to start at if decoupled:** `1.0.0`. It is the installer's first release, `2.1.7` is a
number it never had a reason to claim, and the two-track story is clearer to a reader than a package
that starts at 2.1.7 and then drifts.

### D3 — Clone `main`, not a tag.

Recommendation: keep `main`. Two independent reasons, either sufficient:

- **Two of the three legs cannot be pinned.** `claude plugin marketplace add KarrixLee/nomo` and
  `codex plugin marketplace add KarrixLee/nomo` take an owner/repo and read the default branch. There
  is no tag argument. Pinning only the OpenCode leg would make the three legs install *different
  versions from the same command* — strictly worse than all three tracking one branch.
- **A tag breaks the update path.** `bin/nomo-ai.mjs:180` runs `git pull --ff-only` on an existing
  `~/.nomo`. A tag clone is a detached HEAD, where `git pull --ff-only` fails outright; pinning would
  force a rewrite to `git fetch --tags && git checkout <tag>` and a way to learn the new tag.

**Update (`--ref`, shipped).** The installer now takes `--ref <branch-or-tag>`, which neither of
those two reasons contradicts: the *default* is still the default branch, so a plain `bunx nomo-ai`
keeps all three legs on one branch, and the flag prints the caveat above — that Claude Code and Codex
install from the default branch regardless — whenever it is used with those legs. The `--ff-only`
problem is avoided structurally rather than solved: a `--ref` checkout is deliberately **detached**
and reconciles with `git fetch --depth 1 origin <ref> && git checkout --detach FETCH_HEAD`, one path
for a branch and a tag alike, so `git pull --ff-only` only ever runs on an attached branch. A plain
run that finds a detached `~/.nomo` refuses and names the pin instead of failing inside git.

The real cost of tracking `main` is the one D1 names: `main` must always be installable. That is a
branch-discipline commitment, not a code change — no half-finished merges on `main`, releases land as
one merge, and the `v*` tag is a marker for humans rather than something the installer reads.

### D4 — Provenance. Worth CI, but the first publish cannot use it.

**npm facts, checked against the docs (Aug 2026):**

- Trusted publishing (OIDC) requires **npm CLI ≥ 11.5.1 and Node ≥ 22.14** on the runner, and grants
  provenance **automatically** on GitHub Actions.
- **`bun publish` has no `--provenance` flag** (checked `bun publish --help` on 1.3.14). Provenance is
  the one place npm's own CLI is unavoidable — and it only runs inside CI, never on the laptop.
- **The package must already exist on npm before a trusted publisher can be configured.** The
  npmjs.com settings page for the package is the only place to configure it, and there is no page for
  a name that has never been published. This is a known npm limitation (npm/cli#8544). So the *first*
  publish is manual, by definition.
- **Classic/automation tokens no longer exist** — removed November 2025. Only granular access tokens
  remain, and they carry an explicit **"Bypass 2FA"** switch that is **false by default**. A granular
  token created with the default setting, dropped into `NPM_TOKEN`, **will fail** a CI publish on an
  account that requires 2FA for writes. That is the trap this decision exists to avoid.

**Recommendation: yes to CI, no to a token.** For this package the trust story *is* the product —
the README's own argument is "a package that edits your agent config is the shape you should
distrust." Provenance is the counter-evidence: a verified badge on npmjs.com linking the tarball to
the commit and workflow that built it. Trusted publishing gets that with **no long-lived secret in
the repo at all**, which is a better outcome than the laptop publish, not just a fancier one.

Two phases, and they must be in this order:

- **Phase 1 (first release, manual).** `npm login`, `bun publish` from the laptop with an interactive
  2FA OTP. No provenance on this one version. Accept that.
- **Phase 2 (every release after).** On npmjs.com → package → Settings → Trusted Publisher: GitHub
  Actions, repo `KarrixLee/nomo`, workflow filename, environment (leave blank unless you add one).
  Then one workflow, triggered on `v*` tags, with `permissions: { id-token: write, contents: read }`,
  `actions/setup-node` at Node ≥ 22, `npm install -g npm@latest`, `npm publish`. No `NPM_TOKEN`
  secret. Do **not** create a granular token "just in case" — an unused publish token is pure
  attack surface once trusted publishing works.

**What the user must configure, precisely:**

1. An npm account with 2FA enabled (required for publishing regardless).
2. `npm login` on this machine, once, for the first publish only.
3. After the first publish: the Trusted Publisher entry above.
4. Nothing in GitHub Secrets.

**Decide before any workflow file is written:** whether CI's job is *only* `npm publish`, or also
`bun test` + `bun build.ts` + a `git diff --exit-code plugin/dist` check. The repo commits `dist/`
and has no CI, so a stale-`dist` guard is the highest-value thing a runner could do here — but it is
a separate decision from publishing, and bundling them means a flaky test blocks a release.

### D5 — Irreversibility. Ship the first version to `next`, then move `latest`.

**npm facts, checked:** unpublish is unrestricted only within **72 hours**; after that only with no
dependents and per the unpublish policy. Critically, **`name@version` can never be reused** — a
version you unpublish is burned forever, and unpublishing the whole package blocks new publishes for
**24 hours**. After the window the only tool is `npm deprecate`, which leaves the version installable.

For a package whose entire job is running commands on someone's machine, a bad `latest` on day one is
the expensive failure. So the first publish gets a dist-tag detour — two extra commands to make the
irreversible step reversible:

```sh
bun publish --tag next          # 1.0.0 exists, but `bunx nomo-ai` still resolves nothing
bunx nomo-ai@next --dry-run --all   # verify on a machine where ~/.nomo does NOT exist
bunx nomo-ai@next                   # then a real run, all three legs
npm dist-tag add nomo-ai@1.0.0 latest   # npm-only; bun has no dist-tag command
```

If step 2 or 3 fails, nothing is pointing at the broken build: fix, bump to `1.0.1`, republish to
`next`. `latest` only ever moves onto a version that has been run end to end. Dist-tag moves are free
and reversible; unpublish is neither.

Subsequent releases publish straight to `latest`.

---

## 3. Pre-publish checklist

Every time. Roughly two minutes.

```sh
# 1. On the right code, clean tree, and main already has it (D1)
git status --porcelain                    # empty
git branch --show-current
git log --oneline origin/main -1          # contains this release

# 2. Manifests agree and dist/ is reproducible from source
bun build.ts                              # refuses on manifest disagreement
git diff --exit-code plugin/dist          # empty: committed bundle == freshly built
bun test

# 3. Tarball: exactly 4 files, nothing else
npm pack --dry-run                        # LICENSE, README.md, bin/nomo-ai.mjs, package.json
                                          # bun pm pack also works; npm's listing is clearer

# 4. Run the ARTIFACT, not the working tree
npm pack && npm i -g ./nomo-ai-<v>.tgz
nomo-ai --version && nomo-ai --dry-run --all
npm rm -g nomo-ai && rm nomo-ai-<v>.tgz

# 5. Publish (see D5 for the first one)
npm whoami                                # not ENEEDAUTH
bun publish --dry-run
bun publish
```

Notes on each:

- **Step 3 is a secret check, not a size check.** `files: ["bin/"]` is a whitelist, so the failure
  mode is not a stray dotfile — it is someone adding a directory to `files` later. Read the file
  list, do not just confirm the count.
- **Step 4 is the one people skip.** `node bin/nomo-ai.mjs` proves the working tree runs; it does not
  prove the *tarball* runs. The installer reads `../package.json` at runtime
  (`bin/nomo-ai.mjs:36`) — that resolves inside the tarball only because npm always includes
  `package.json`. Install the tarball and run the installed binary.
- **The name check is free**: `npm view nomo-ai version` after publishing tells you `latest` is what
  you think it is.
- **README drift is not cross-checked.** `README.md:350` currently says the version is **2.1.5**
  while every manifest says 2.1.7. `build.ts` checks JSON, not prose. Either fix the sentence to not
  carry a number, or add it to this checklist. Recommend the former — a number in prose is a number
  that goes stale.

---

## 4. Settled and non-issues

**Name: `nomo-ai`, public, unscoped. Settled — no reason found to revisit.** The obvious reason to
scope would be that the good name is taken; it is not (`nomo-ai` → 404, and it is `nomo` that is
occupied, which is presumably why `nomo-ai` was picked). Unscoped also keeps `bunx nomo-ai` a
five-character advantage over `bunx @karrixlee/nomo`, and it matches the App Store listing
("Nomo — AI Status"). Scoping would additionally require `--access public` on every publish, which
is one more thing to forget. Leaving it alone.

**bun vs npm.** `bun publish` is the publish command — it reads `~/.npmrc`, supports `--otp` and
`--auth-type`, and honours `files`. npm's own CLI is needed in exactly three places, all noted above:
`npm login` (once), `npm dist-tag` (bun has no equivalent), and `npm publish --provenance` inside CI
(bun has no provenance flag). `npm pack --dry-run` is preferred over `bun pm pack` only because its
file listing is easier to read at a glance.

**Docs site.** Nothing is required for this release. `docs.nomo.gg` lives in a separate private repo
under another owner and every page is a six-language commitment, so the cheapest correct answer is to
change nothing there until `bunx nomo-ai` has been publicly working for a release cycle. When it is
worth doing, the ask is one line on the existing install page — *"or run `bunx nomo-ai`"* — not a new
page. Hand that to whoever owns that repo; do not write it from here.

---

## 5. Decide before any code is written

1. **D2 — couple or decouple the installer version.** This changes `build.ts`, the README's
   "five manifests" paragraph, and whether every future plugin bump obligates an npm publish.
   Recommendation: decouple, start the installer at `1.0.0`.
2. **D4 — CI scope.** Publish-only, or publish + `bun test` + a stale-`plugin/dist` guard.
   Recommendation: publish-only first; add the `dist` guard as a separate always-on workflow where a
   failure blocks a PR rather than a release.
3. **Who owns the npm account** and whether a second maintainer needs publish rights. Relevant now
   rather than later: adding an owner later is easy, recovering a solo account is not.
