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

Installs and updates reach Gitea through `--@agent:registry=<url>`, never a global `--registry`: the Gitea registry hosts only `@agent` and does not proxy public npm, so a global flag makes every dependency 404. The auto-update, the manual-update hint, the interrupted-update recovery hint and the damaged-skill reinstall hint all print the scoped form; `TEAMAI_NPM_REGISTRY` still overrides it with a global `--registry`.

`npx teamai-cli` is not supported for the fork: it fetches the upstream package from public npm. Upstream's CI examples (`docs/guide/benchmarks.md`, `self-improvement.md`, `workflow.md`) keep `npx teamai-cli` unchanged. The workflow skill driver's `npx teamai-cli` literals (`src/workflow/drivers/skill/literals.ts`) are used only when the running CLI itself was started from npm's `_npx` cache, which an `npm install -g @agent/teamai-cli` install never is; the `npx teamai-cli` entries in generated skills' `allowed-tools` are permission patterns, not commands teamai runs.
