---
name: forgejo-cli
description: Forgejo CLI (fj) quick reference for managing issues, pull requests, releases, repos, and more on Forgejo instances from the command line.
---

# Forgejo CLI (`fj`)

Quick reference for `fj` — the Forgejo command-line client. Use when working with Forgejo-hosted repositories, issues, PRs, releases, or CI actions.

## Authentication

```bash
# Interactive login (opens browser)
fj auth login

# List configured logins
fj auth list

# Verify authentication
fj whoami

# Logout from an instance
fj auth logout
```

**Agent note:** `fj auth login` is interactive (opens browser). Ensure auth is configured before using other commands. When no repo context is available, use `--host <URL>` or `--repo <owner/repo>`.

## Specifying the Target

Most commands accept these flags to identify the target repo:

| Flag | Meaning |
|------|---------|
| `-r, --repo <REPO>` | `owner/repo` on the default host |
| `-R, --remote <REMOTE>` | Local git remote name (e.g. `origin`) |
| `-H, --host <HOST>` | Forgejo instance URL |

When inside a git repo with a Forgejo remote, `fj` auto-detects the repo. Outside a repo, always pass `--repo`.

## Issues

```bash
# List/search issues
fj issue search                        # Open issues in current repo
fj issue search "bug" -s all           # Search all issues containing "bug"
fj issue search -l bug,critical        # Filter by labels
fj issue search -a username            # Filter by assignee
fj issue search -c username            # Filter by creator
fj issue search -r owner/repo          # Specific repo

# View issue
fj issue view 42                       # View issue #42
fj issue view 42 comments              # View all comments on issue #42
fj issue browse 42                     # Open in browser

# Create issue
fj issue create "Title" --body "Description"
fj issue create "Title" --body-file description.md
fj issue create --web                  # Open creation page in browser

# Edit issue
fj issue edit 42 title "New Title"
fj issue edit 42 body                  # Opens editor
fj issue edit 42 comment <COMMENT_ID>  # Edit a specific comment

# Comment on issue
fj issue comment 42 "Comment text"
fj issue comment 42 --body-file comment.md

# Close issue
fj issue close 42
```

## Pull Requests

```bash
# List/search PRs
fj pr search                           # Open PRs in current repo
fj pr search "feature" -s all          # All PRs matching "feature"
fj pr search -l needs-review           # Filter by label
fj pr search -a username               # Filter by assignee
fj pr search -r owner/repo             # Specific repo

# View PR
fj pr view 15                          # PR overview
fj pr view 15 diff                     # View the diff
fj pr view 15 comments                 # View all comments
fj pr view 15 files                    # Changed files list
fj pr view 15 commits                  # Commits in PR
fj pr view 15 labels                   # Labels on PR
fj pr status 15                        # Mergeability & CI status
fj pr browse 15                        # Open in browser

# Create PR
fj pr create "Title" --body "Description" --base main --head feature-branch
fj pr create --autofill                # Auto-fill from commits
fj pr create "WIP: Draft PR"           # Prefix with "WIP:" for draft

# Checkout PR locally
fj pr checkout 15
fj pr checkout 15 --branch-name my-fix

# Comment on PR
fj pr comment 15 "Comment text"
fj pr comment 15 --body-file review.md

# Edit PR
fj pr edit 15 title "New Title"
fj pr edit 15 body

# Merge PR
fj pr merge 15                         # Default merge style
fj pr merge 15 -M squash               # Merge styles: merge, rebase, rebase-merge, squash, manual
fj pr merge 15 -M squash -d            # Delete branch after merge
fj pr merge 15 -M squash -t "Title" -m "Body"

# Close PR (without merging)
fj pr close 15
```

## Releases

```bash
# List releases
fj release list
fj release list -p                     # Include pre-releases
fj release list -d                     # Include drafts
fj release list -r owner/repo

# View release
fj release view v1.0.0
fj release browse v1.0.0               # Open in browser

# Create release
fj release create v1.0.0 -b "Release notes"
fj release create v1.0.0 -b --create-tag             # Create tag + release, opens editor for body
fj release create v1.0.0 -T                           # Shorthand: create tag named like release
fj release create v1.0.0 -t v1.0.0 -b "Notes"        # Use existing tag
fj release create v2.0.0-beta -b "Beta" -p            # Pre-release
fj release create v2.0.0 -b "Draft" -d                # Draft
fj release create v1.0.0 -b "Notes" -a ./dist/app.tar.gz              # Attach file
fj release create v1.0.0 -b "Notes" -a ./build/linux:app-linux        # Custom asset name

# Edit release
fj release edit v1.0.0 -b "Updated notes"

# Delete release
fj release delete v1.0.0

# Release assets
fj release asset create v1.0.0 ./file.tar.gz
fj release asset download v1.0.0 file.tar.gz
fj release asset delete v1.0.0 file.tar.gz
```

## Repositories

```bash
# View info
fj repo view
fj repo view owner/repo
fj repo readme owner/repo

# Create repo
fj repo create myrepo -d "Description" -P            # Private repo
fj repo create myrepo --push                          # Create & push current branch

# Clone repo
fj repo clone owner/repo
fj repo clone owner/repo ./target-dir
fj repo clone owner/repo -S                           # Clone over SSH

# Fork repo
fj repo fork owner/repo

# Star/unstar
fj repo star owner/repo
fj repo unstar owner/repo

# Delete repo
fj repo delete owner/repo

# Browse in browser
fj repo browse
```

## Tags

```bash
fj tag list
fj tag create v1.0.0
fj tag delete v1.0.0
fj tag view v1.0.0
```

## CI Actions

```bash
# List tasks (workflows)
fj actions tasks -r owner/repo

# Dispatch a workflow
fj actions dispatch workflow-name main
fj actions dispatch workflow-name main -I 'key=value'

# Variables & secrets
fj actions variables -r owner/repo
fj actions secrets -r owner/repo
```

## Wiki

```bash
fj wiki contents -r owner/repo
fj wiki view PageName -r owner/repo
fj wiki clone owner/repo              # Clone wiki repo
fj wiki browse -r owner/repo          # Open wiki in browser
```

## Users & Organizations

```bash
# Users
fj user search username
fj user view username
fj user repos username
fj user activity username
fj user browse username

# Organizations
fj org list
fj org view orgname
fj org create orgname
fj org members orgname
fj org activity orgname

# Teams
fj org team list orgname
fj org team view orgname team-slug
fj org team create orgname team-name
```

## Agent Gotchas

1. **No `--output` flag** — unlike `tea`, `fj` doesn't have `--output json/simple`. Output is always human-readable. Parse with care.
2. **Body opens editor** — `--body` without a value or omitting it opens `$EDITOR`. Always provide `--body "text"` or `--body-file file.md` explicitly.
3. **Repo context required** — most commands fail without repo context. Use `--repo owner/repo` when outside a git repo, or ensure you're in a directory with a Forgejo remote.
4. **`--style minimal`** — use `--style minimal` to strip ANSI colors and special characters when parsing output programmatically.
5. **PR draft** — prefix title with `"WIP: "` to create a draft PR (no `--draft` flag).
6. **Merge styles** — `merge`, `rebase`, `rebase-merge`, `squash`, `manual`.
