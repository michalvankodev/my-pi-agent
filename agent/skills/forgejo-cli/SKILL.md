---
name: forgejo-cli
description: Forgejo CLI (fj) quick reference for managing issues, pull requests, releases, repos, and more on Forgejo instances from the command line.
---

# Forgejo CLI (`fj`)

Quick reference for `fj` — the Forgejo command-line client for issues, PRs,
releases, and repos. Verified against **fj v0.4.1** (installed at
`~/.cargo/bin/fj`). Check `fj version` — subcommand flags drift between
versions, always re-verify with `--help` when something errors.

## Top-level options

Placed between `fj` and the subcommand:

```bash
fj -H <HOST> --style minimal pr search
```

| Flag | Meaning |
|---|---|
| `-H, --host <URL>` | Forgejo instance URL (when no repo context) |
| `--style fancy\|minimal` | Output mode; `minimal` = no ANSI/colors. **Always used automatically when piped.** |

## Authentication

```bash
fj auth list                  # Configured logins
fj whoami                     # Verify auth for current repo context
fj auth login                 # Interactive (opens browser)
fj auth add-key <USER> [KEY]  # Non-interactive: register an existing API token
                              # (reads key from stdin if omitted)
fj auth use-ssh               # Use SSH keys instead of tokens
fj auth logout                # Remove login info for an instance
```

**Agent note:** `fj auth login` is interactive (browser) — in agent sessions use
`fj auth add-key <user> <token>` with a pre-existing token instead. Tokens can
be minted on the server via
`ssh <host> 'podman exec <container> gitea admin user generate-access-token --username <user> --token-name <name> --scopes write:repository,write:issue,read:user'`
(adjust container/repo scope to the instance at hand).

## Specifying the target repo

**The big gotcha: flag placement is inconsistent per subcommand.** Some take
`-R/--remote` (local git remote name), some `-r/--repo` (`owner/name`), some
both, some neither (they only inherit repo context from cwd):

| Subcommand | Repo flags |
|---|---|
| `pr search`, `pr create`, `repo clone` | `-r, --repo <owner/name>` |
| `issue create`, `release`, `actions`, `wiki` | `-R, --remote <remote>` |
| `issue search`, `actions tasks` | both `-r/--repo` and `-R/--remote` |
| `whoami` | `-r, --remote` (lowercase!) |
| `pr view/comment/merge/...` (by ID) | inherit from cwd |

Inside a git repo with a Forgejo remote, `fj` auto-detects the repo. With
multiple Forgejo remotes, pick one with the flags above.

## Issues

```bash
fj issue search                       # Open issues in current repo
fj issue search "bug" -s all          # All issues matching "bug" (states: open|closed|all)
fj issue search -l bug,critical       # Filter by labels
fj issue search -a username           # Filter by assignee
fj issue search -c username           # Filter by creator

fj issue view 42                      # View issue
fj issue view 42 comments             # All comments
fj issue browse 42                    # Open in browser

fj issue create "Title" --body "Description"
fj issue create "Title" --body-file description.md
fj issue create --web                 # Open creation page in browser
fj issue templates                    # List issue templates (use --template if blanks disabled)

fj issue edit 42 title "New title"    # Edit title
fj issue edit 42 body                 # Edit body (opens editor)
fj issue edit 42 comment <COMMENT_ID> # Edit one comment

fj issue comment 42 "text"            # Comment (or --body-file file.md)
fj issue close 42
```

## Pull Requests

```bash
fj pr search                          # Open PRs (there is NO `fj pr list`!)
fj pr search "redesign" -s all        # All PRs matching text
fj pr search -l needs-review          # By label

fj pr view 15                         # Overview
fj pr view 15 diff                    # The diff
fj pr view 15 comments                # All comments
fj pr view 15 files                   # Changed files
fj pr view 15 commits                 # Commits in PR
fj pr status 15                       # Mergeability & CI status
fj pr browse 15

fj pr create "Title" --base main --head feature-branch --body "Description"
fj pr create --autofill               # Title/body from commits
fj pr create "WIP: Draft"             # "WIP: " prefix = draft PR (no --draft flag)
fj pr create ... --web                # Open creation page in browser
fj pr create ... -a                   # AGit-flow PR

fj pr checkout 15                     # Check out PR #15 in a new branch
fj pr checkout 15 --branch-name my-fix
fj pr checkout ^15                    # ^ prefix = PR from the parent repo (forks)

fj pr comment 15 "text"               # Or: fj pr comment 15 --body-file review.md
fj pr edit 15 title "New title"
fj pr edit 15 body                    # Opens editor
fj pr close 15

fj pr merge 15                        # Default merge style
fj pr merge 15 -M rebase -d           # -M: merge|rebase|rebase-merge|squash|manual
fj pr merge 15 -M squash -t "Title" -m "Body" -d   # -d deletes the branch after
```

## Releases

```bash
fj release list                       # -p include pre-releases, -d include drafts
fj release view v1.0.0
fj release browse v1.0.0

fj release create v1.0.0 -b "Notes"
fj release create v1.0.0 -b --create-tag           # + tag, opens editor for body
fj release create v1.0.0 -b "Notes" -T             # Shorthand: tag named like release
fj release create v1.0.0 -b "Notes" -t existing-tag
fj release create v1.0.0 -b "Draft" -d             # Draft release
fj release create v1.0.0 -b "Notes" -p             # Pre-release
fj release create v1.0.0 -b "Notes" -a ./app.tar.gz
fj release create v1.0.0 -b "Notes" -a ./build/app-linux:app-linux  # Custom asset name

fj release edit v1.0.0 -b "New notes"
fj release delete v1.0.0

fj release asset create v1.0.0 ./file.tar.gz
fj release asset download v1.0.0 file.tar.gz
fj release asset delete v1.0.0 file.tar.gz
```

## Repositories

```bash
fj repo view                          # Current repo (or owner/repo)
fj repo view owner/repo
fj repo readme owner/repo
fj repo browse

fj repo create myrepo -d "Description"   # -P private, --push pushes current branch
fj repo clone owner/repo                 # -S over SSH
fj repo fork owner/repo
fj repo migrate                          # Migrate a repo from another forge
fj repo delete owner/repo
fj repo star owner/repo
fj repo unstar owner/repo
```

## Tags

```bash
fj tag list
fj tag create v1.0.0
fj tag view v1.0.0
fj tag delete v1.0.0
```

## CI Actions

```bash
fj actions tasks                      # List workflow tasks
fj actions dispatch workflow-name main     # Dispatch (branch)
fj actions dispatch workflow-name main -I 'key=value'
fj actions variables
fj actions secrets
```

## Wiki

```bash
fj wiki contents
fj wiki view PageName
fj wiki clone
fj wiki browse
```

## Users & Organizations

```bash
fj user search username
fj user view username
fj user repos username
fj user activity username
fj user browse

fj org list
fj org view orgname
fj org create orgname
fj org members orgname
fj org team list orgname
fj org team view orgname team-slug
fj org team create orgname team-name
```

## Agent Gotchas

1. **No `--output` flag / no JSON** — output is always human-readable. `--style minimal` strips ANSI (automatic when piped); parse with care.
2. **Body opens editor** — `--body` without a value, or omitting it, opens `$EDITOR`. Always pass `--body "text"` or `--body-file file.md` explicitly.
3. **No `pr list`** — use `fj pr search` (issues too: `fj issue search`).
4. **Version check is `fj version`** — not `fj --version`.
5. **Repo flags are inconsistent** (`-R/--remote` vs `-r/--repo`, see table above) — if one errors, check that subcommand's `--help`.
6. **PR drafts** — prefix title with `"WIP: "`; there is no `--draft` flag.
7. **Merge styles** — `merge`, `rebase`, `rebase-merge`, `squash`, `manual` via `-M`.
8. **Login state is per-user global** — `fj whoami` without repo context fails with "not logged in" even inside a repo if no auth is configured; use `fj auth add-key <user> <token>` to fix non-interactively.
9. **Default host can be wrong** — commands that take only `owner/repo` (no remote flag) may resolve to a stale default instance. Always pass `-H https://<instance>` explicitly when multiple Forgejo instances have logins (check `fj auth list`).
