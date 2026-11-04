# Issue tracker: GitHub

Issues, specs, triage comments, labels, and code PRs live on GitHub `qinyuanj/teamai-cli`, the primary official fork of `Tencent/teamai-cli`. Use `gh` with `--repo qinyuanj/teamai-cli` on every issue and PR command: GitHub fork detection can otherwise select upstream. Git remotes also use GitHub; Gitea remains only the `@agent/teamai-cli` publishing registry.

## Conventions

- **Create an issue**: `gh issue create --repo qinyuanj/teamai-cli --title "..." --body-file <file> --label "bug,needs-triage"` (labels are comma-separated).
- **Read an issue**: `gh issue view <number> --repo qinyuanj/teamai-cli --comments`. For structured output, use `--json number,state,author,title,body,labels,comments,createdAt,updatedAt`.
- **List issues**: `gh issue list --repo qinyuanj/teamai-cli --state open --label needs-triage --limit 50`. Filters include `--search`, `--author`, and `--state all|open|closed`.
- **Comment**: `gh issue comment <number> --repo qinyuanj/teamai-cli --body-file <file>`. Use a UTF-8 file with actual newlines for multiline issue bodies, PR descriptions, and comments.
- **Apply / remove labels**: `gh issue edit <number> --repo qinyuanj/teamai-cli --add-label "a,b" --remove-label "c"`.
- **Close**: comment with the resolution first, then `gh issue close <number> --repo qinyuanj/teamai-cli`. Reopen with `gh issue reopen <number> --repo qinyuanj/teamai-cli`.
- **List / create labels**: `gh label list --repo qinyuanj/teamai-cli`; `gh label create <name> --repo qinyuanj/teamai-cli --color ededed --description "..."`. Use the vocabulary in [triage-labels.md](triage-labels.md); check the GitHub label inventory before applying labels and create missing labels when label setup is authorized.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

Code PRs target `qinyuanj/teamai-cli` with base `main`:

- **Create a PR**: `gh pr create --repo qinyuanj/teamai-cli --base main --head <branch> --title "..." --body-file <file>`.
- **Read / diff**: `gh pr view <number> --repo qinyuanj/teamai-cli --comments`; `gh pr diff <number> --repo qinyuanj/teamai-cli`.
- **List PRs**: `gh pr list --repo qinyuanj/teamai-cli --state open --limit 50`.
- **Comment / label / close**: `gh pr comment <number> --repo qinyuanj/teamai-cli --body-file <file>`; `gh pr edit <number> --repo qinyuanj/teamai-cli --add-label "a,b" --remove-label "c"`; `gh pr close <number> --repo qinyuanj/teamai-cli`.

When the request-surface flag is `yes`, apply the same triage labels and states to PRs. GitHub shares one number space across issues and PRs; resolve a bare `#42` against this fork using the ticket URL or `gh api repos/qinyuanj/teamai-cli/issues/42` (a `pull_request` field identifies a PR). Preserve the repository in links to historical upstream tickets.

## When a skill says "publish to the issue tracker"

Create a GitHub issue with `gh issue create --repo qinyuanj/teamai-cli` and the title, body file, and labels above.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo qinyuanj/teamai-cli --comments`; use `gh pr view` for a PR.
