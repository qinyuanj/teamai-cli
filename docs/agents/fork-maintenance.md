# Fork maintenance

GitHub `qinyuanj/teamai-cli` is the primary official fork of `Tencent/teamai-cli`. Git remotes use GitHub: `origin` for the fork and `upstream` for Tencent. Issues and PRs also use GitHub; see [issue-tracker.md](issue-tracker.md). Gitea is used only as the fork package registry.

## Manual upstream updates

Maintain qinyuanj / 覃远杰's changes as a small set of themed commits rebased onto `upstream/main`. Upstream updates are manual: preserve a linear history rather than merging upstream.

1. Work in an isolated worktree with a clean working tree. Verify that remote URLs point to GitHub and fetch `origin` and `upstream`. Record the current `origin/main` tip for the later push lease.
2. Before rewriting history, create a uniquely named `backup/*` branch for the current fork main. Keep the old history available until the updated GitHub fork has been verified.
3. Select the authorized baseline: `upstream/main` for a rolling update or a verified upstream release tag for a release rebuild. Rebase the fork themes onto that baseline. Drop patches already included there; preserve the remaining fork behavior and fold follow-up fixes into their themed commits.
4. Inspect `git log <baseline>..HEAD` and the full fork diff. Every remaining commit must belong to a fork theme. Run `npm run build`, `npx tsc --noEmit`, `npm run lint`, and `npx vitest run`; verify changed runtime behavior with a representative real-CLI run.
5. When publishing the update is authorized, push the validated history to `origin/main` using `--force-with-lease` against the recorded remote tip. If the remote has advanced, inspect those changes before retrying.
6. Verify that `origin/main` points to the validated commit. Preserve historical upstream tags and keep fork package release tags in the `gitea-v*` namespace.

Feature work and PRs start from `origin/main`. Before pushing a feature branch, inspect `git log origin/main..HEAD` and remove unrelated commits by rebasing or cherry-picking.

## Fork publishing

The inherited public npm release workflow is reserved for `Tencent/teamai-cli`; upstream tags and releases do not publish the fork package. Fork packages remain `@agent/teamai-cli` on the Gitea registry.

- A build exactly matching an upstream release uses that upstream version number.
- Between upstream releases, use the next patch with `-gitea.N`, for example `0.24.1-gitea.0`.
- Tag the publishing commit with an annotated `gitea-v<version>` tag.
- Before publishing, build the tagged commit and verify that its package contents match the artifact being published. Verify the resulting registry version after publishing.

Build fork packages from the validated GitHub fork history. Publishing credentials and registry configuration remain specific to Gitea; package publishing does not require a Gitea Git remote.

A `-gitea.N` version is a prerelease. Publish it with `--tag latest`: npm refuses an untagged prerelease publish, and auto-update reads the `latest` dist-tag. `compareVersions` orders prereleases of one core by their identifiers (semver §11.4), so `-gitea.N` installs see `-gitea.N+1`.

Installs and updates reach Gitea through `--@agent:registry=<url>`, never a global `--registry`: the Gitea registry hosts only `@agent` and does not proxy public npm, so a global flag makes every dependency 404. The auto-update, the manual-update hint and the damaged-skill reinstall hint all print the scoped form; `TEAMAI_NPM_REGISTRY` still overrides it with a global `--registry`.

`npx teamai-cli` is not supported for the fork: it fetches the upstream package from public npm. Upstream's CI examples (`docs/guide/benchmarks.md`, `self-improvement.md`, `workflow.md`) keep `npx teamai-cli` unchanged. The workflow skill driver's `npx teamai-cli` literals (`src/workflow/drivers/skill/literals.ts`) are used only when the running CLI itself was started from npm's `_npx` cache, which an `npm install -g @agent/teamai-cli` install never is; the `npx teamai-cli` entries in generated skills' `allowed-tools` are permission patterns, not commands teamai runs.

## 0.29.0 rebuild

A trial rebase of the 0.28 topics onto upstream `v0.29.0` (`1e2816f9`; 165 commits, 1328 files) conflicted on every topic, so the fork was rebuilt from the tag instead: each fork change was redone or dropped on 0.29, in themed commits (package and fork docs, generic small fixes, Gitea, Kimi). The tag's `v0.29.0..upstream/main` commits are not included.

Dropped, because upstream now covers them or they are no longer worth carrying: the init Git identity preflight; pull's skipped-target report and `status` hint; pull skipping a same-name skill and exiting 1 (upstream picks a deterministic winner and warns, Tencent/teamai-cli#1584; pre-push now uses that winner); the `sharing.rules.enforced` removal and doctor's unknown-key warning; the `[teamai:rules]` and fork Windows Codex hooks migrations (all members are on fork 0.28 or later); `members register` residue, the `hermes-config` refactor, recall shared markers and the Kimi legacy agent id map.

Plain-tag baseline on this machine (WSL, Node 24, npm 12): build, type check and lint pass; `npx vitest run` has 28 failures, 17 of them environment failures that also fail alone (Cursor stores, team env shell profiles, Git discovery, `session-push`, submodule checkouts, Claude-hook Windows-shell guards) and 11 that fail only under full-suite load. `npm ci` there needs `--allow-remote=all`, because the lockfile resolves packages from a Tencent mirror and npm 12 refuses remote tarball URLs by default.

Gitea on 0.29: the provider reads pull request history with real pagination (`limit`/`page`, using `x-next-page` when present and a full-page fallback otherwise), mapping open, closed and merged requests with `mergedAs`, and imports `/pulls/` URLs with their review threads. It deliberately has no `checks`, so workflow delivery reports CI as `unsupported` — a known gap against GitHub and GitLab, same as TGit and GitCode. Plain-HTTP pull request URLs are a carve-out in `src/workflow/pr-url.ts` for the configured `GITEA_URL` host and port only; the `PrUrl` brand stays HTTPS-only everywhere else.

Final verification on the rebuilt branch (WSL, Node 24, 2026-11-05): `npm run build`, `npx tsc --noEmit --project <worktree>/tsconfig.json` and `rtk bypass npm run lint` passed. The full suite had 24 failed, 21997 passed and 73 skipped across 706 files: 23 failures were in the plain-tag baseline; the remaining `score-skill-routing` load timeout passed alone (6 tests). The real-CLI Gitea init/push/import-mr and Kimi hooks/rules/agents e2e run passed 13 tests in 5 files. The packed tgz installed into an empty prefix prints `0.29.0`; update checks covered 0.28.2-gitea.0 → 0.29.0 and -gitea.0 → -gitea.1.

A real Gitea instance was checked on 2026-11-05 using the configured HTTP URL and token. Existing PRs confirmed `merged`, a 40-character `merge_commit_sha`, and `html_url` retaining the instance protocol, host and port. A temporary private repository with two PRs confirmed that `limit=1&page=1` and `page=2` return distinct entries even though this instance omits `x-next-page` (it supplies `x-total-count`, so the full-page fallback is required). Submitted reviews had state `COMMENT`, a separately created reply was its own review, and each review's code comments exposed `position`/`original_position` as read by the provider; a draft review reported `PENDING`. The temporary repository was deleted after the read-only response checks.

## 0.29.0 rebuild: Kimi Code measurements

Kimi Code CLI 2.4.1, measured 2026-11-04 on WSL2 with an isolated `KIMI_CODE_HOME`; the exact commands and payloads are in `/home/lzx/migration/teamai-rebuild/kimi-probe.md`. Plain `UserPromptSubmit` stdout reaches the model. A wildcard `PostToolUse` receives skill loads as `tool_name: "Skill"` and `tool_input.skill`, and Kimi calls its todo tool `TodoList`. Kimi ignores `additionalContext`: its JSON reply uses `message`, which hook dispatch now writes. `SessionStart` and `PostToolUse` output never reached the model. Plain Stop output did not continue the turn; a Stop deny forced exactly one more turn, but `stopReply: false` keeps the hint for the next prompt instead. The evidence used by the descriptor is these runs (`verified`), not a claim about an unprobed capability.

## 0.28.2-gitea.0 release

Fixes on top of 0.28.1 (PR #9): the session-start `score-sessions` worker ran `where` without `windowsHide`, which flashed about ten Windows Terminal windows per session start; and `compareVersions` now orders prereleases with the same core, so `-gitea.N` installs auto-update to `-gitea.N+1`.

`@agent/teamai-cli@0.28.2-gitea.0` was published to the Gitea registry on 2026-10-29 from `b4eacce9` (annotated tag `gitea-v0.28.2-gitea.0`, pushed to GitHub), after `npm run build` at that commit, with `--tag latest`. The registry `dist.shasum` (`e8aeece6`) matches the tarball packed from it, `npm exec --package=@agent/teamai-cli@0.28.2-gitea.0 -- teamai --version` prints `0.28.2-gitea.0`, and an installed 0.28.1 with no cached check reports `Update available: v0.28.1 → v0.28.2-gitea.0`. Publishing used `GITEA_TOKEN` through a temporary `--userconfig`.

## 0.28.1 rebuild

The local rebuild uses the official upstream `v0.28.1` commit `0df524c1`. The previous fork history is retained on `backup/fork-before-0.28.1-20261028-7699e222`; the force-push lease is `origin/main` = `7699e222`. The topic commits replay as before; upstream's new tool-descriptor fields (hooks, sessions, features) and README matrix columns are filled in for Kimi, and the fixes 0.28.1 needed sit in one `fix(fork): integrate upstream 0.28.1` commit on top (Git 2.43 here has no non-interactive autosquash).

Verification on the final history (WSL, Node 24):

- `npm run build`, `npx tsc --noEmit --project <worktree>/tsconfig.json` and `rtk bypass npm run lint` passed.
- `npx vitest run`: 17658 passed, 15 failed, 57 skipped (596 files). The 15 (Cursor stores, team env shell profiles, Git discovery, `session-push`, submodule checkouts) are the same 15 that fail on the plain `v0.28.1` tree in this environment. `session-scoring`, `workflow-reconciliation` and `workflow-settle-cost` failed in one earlier full run only, and pass when their files run alone.
- Real CLI, after `npm run build`: `kimi-rules` and `skill-selection` e2e passed 5 tests (Kimi project delivery and uninstall; skill-name collisions with the git, gitlab, github and gitea providers). The packed `@agent/teamai-cli-0.28.1.tgz`, installed into an empty prefix, prints `0.28.1` and lists `gitea` in `init --provider`.

The rebuilt history was pushed to `qinyuanj/teamai-cli` `main` with a force-with-lease, together with the backup branch. `@agent/teamai-cli@0.28.1` was published to the Gitea registry on 2026-10-28 from `0087496f` (annotated tag `gitea-v0.28.1`, pushed to GitHub), after `npm run build` at that commit; the registry `dist.shasum` (`7761c2d1`) matches the tarball packed from it, and `npm exec --package=@agent/teamai-cli@0.28.1 -- teamai --version` prints `0.28.1`. Publishing used the `GITEA_TOKEN` environment variable through a temporary `--userconfig`, not a token written to `~/.npmrc`.

## 0.28.0 rebuild

The local rebuild uses the official upstream `v0.28.0` commit `b5b35749`, excluding commits after that tag. The previous fork history is retained on `backup/fork-before-0.28.0-20261027-abb2241`; the first force-push lease was `origin/main` = `abb22415`.

Where upstream now covers a fork change, upstream's version is kept: `toolPaths` replaces a tool's entry whole (#1185), ZCode and DSH project rules come from the session-start hook (#1219), Windows Codex hooks use `commandWindows` (#1215), a failed init registration is a warning (#1267) whose retry is re-running the same `teamai init` command, so the fork's separate `members register` command is dropped (it also wrote a member file without `projects`), and push resolves ambiguous skill names from its delivery records. The fork themes are Gitea (with the init Git identity preflight), Kimi Code CLI (inline rules in both scopes), dead `teamai.yaml` keys and deterministic scans with duplicate-skill checks, the legacy rules-block migration and recall output markers, a migration test for the fork's Windows Codex hooks, and the package and fork docs.

Verification on the final history (WSL, Node 20):

- `npm run build`, `npx tsc --noEmit` and `rtk proxy npm run lint` passed.
- `npx vitest run`: 16632 passed, 30 failed, 57 skipped (582 files). None of the 30 is fork-specific. 14 (Cursor stores, Git discovery, submodule checkouts, team env shell profiles) fail the same way on the plain `v0.28.0` tree in this environment. `session-push` fails only when run from inside a Git worktree and passes from a plain directory. The rest (`env-advisories`, `score-sessions`, `session-scoring`, `workflow-reconciliation`, `workflow-settle-cost`) fail only under full-suite load and pass when their files run alone.
- Real CLI, after `npm run build`: `npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/kimi-rules.test.ts src/__tests__/e2e/skill-selection.test.ts` passed 5 tests (Kimi project delivery and uninstall with Kimi and DSH enabled; skill-name collisions with the git, gitlab, github and gitea providers).

After the `members register` removal: build, type check and lint passed again, the member/init/bootstrap unit files passed 233 tests, and the full suite's failures stayed in the same categories (10 files, 570 passed). `kimi-rules`, `skill-selection` and `members-legacy-roster` e2e passed 6 tests against the built CLI. Upstream's own `init-registration-result` e2e `failed` case times out in this environment on the plain `v0.28.0` tree as well, so it is not caused by the fork.

The rebuilt history was pushed to `qinyuanj/teamai-cli` `main` with a force-with-lease, together with the backup branch. `@agent/teamai-cli@0.28.0` was published to the Gitea registry on 2026-10-27 from `cf8238b1` (annotated tag `gitea-v0.28.0`, pushed to GitHub); the registry `dist.shasum` matches the tarball packed from that commit, and `npm exec --package=@agent/teamai-cli@0.28.0 -- teamai --version` prints `0.28.0`. Publishing used the `GITEA_TOKEN` environment variable through a temporary `--userconfig`, not a token written to `~/.npmrc`.
