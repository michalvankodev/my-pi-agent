---
name: forgejo-api
description: |
  Interact with Forgejo and Gitea REST APIs — create repos, manage issues and PRs,
  administer users and orgs, search, and more. Use this skill whenever the user mentions
  Forgejo, Gitea, self-hosted git, or needs to interact with a Forgejo/Gitea instance API.
  Also trigger when you see Forgejo URLs, repo creation on self-hosted servers, or the
  user asks about alternatives to GitHub/GitLab for self-hosted git. Trigger phrases:
  'forgejo', 'gitea', 'forgejo api', 'create repo on forgejo', 'self-hosted git api',
  'forgejo issue', 'forgejo pr', 'forgejo admin'.
---

# forgejo-api Skill

Teaches Claude to interact with any Forgejo or Gitea instance via the REST API. Covers auth, API calls, error handling, pagination, and known failure modes.

---

## Section 1: Configuration

Config file location: `~/.claude/forgejo-cli.local.md`

Read this file with the Read tool at the start of every session. If it does not exist, fall back to `FORGEJO_URL` and `FORGEJO_TOKEN` env vars (zero-config path for quick use).

**Fields:**

- `forgejo_url` — required, base URL of the Forgejo instance (no trailing slash)
- `auth_method` — `token-cmd` (preferred), `op`, or `env`
- For `token-cmd`: also set `token_cmd` — any command outputting a token to stdout
- For `op`: also set `op_item`, `op_username_field`, `op_password_field`
- For `env`: set `FORGEJO_TOKEN` in the environment

**Minimal configs.** Each block is the complete file — the first line must be `---`, with no comment
above it.

token-cmd (preferred):

```yaml
---
forgejo_url: https://forgejo.example.org
auth_method: token-cmd
token_cmd: "op read op://<vault>/<item>/<field>"
---
```

op (1Password direct):

```yaml
---
forgejo_url: https://forgejo.example.org
auth_method: op
op_item: my-forgejo
op_username_field: username
op_password_field: password
---
```

env (CI/automation):

```yaml
---
forgejo_url: https://forgejo.example.org
auth_method: env
---
```

See `references/auth-patterns.md` for complete setup examples with all fields.

---

## Section 2: Authentication

Auth flow in 4 steps:

**Step 1:** Read config with the Read tool on `~/.claude/forgejo-cli.local.md`.

**Step 2:** Resolve credentials using the Bash tool:
- `token-cmd`: parse `token_cmd` from config, eval it with `set +x` to suppress trace
- `op`: call `op item get` with the configured item and field IDs
- `env`: read `FORGEJO_TOKEN` from the environment

Always verify the token is non-empty before using it. An empty token means the credential command failed.

**Step 3:** Construct the curl command **inline** with auth arguments.

**CRITICAL RULE**: Process substitution `<(...)` MUST appear inline in the curl command. It cannot be captured as a shell variable or passed as an argument. Always construct the complete curl command in a single Bash invocation.

Quick auth patterns (full examples in `references/auth-patterns.md`):
- token-cmd/env: `-H "Authorization: token $TOKEN"`, or `-H @<(printf 'Authorization: token %s\n' "$TOKEN")` to keep the token out of argv
- op basic auth: `--netrc-file <(printf 'machine %s login "%s" password "%s"\n' "$HOST" "$OP_USER" "$OP_PASS")`

Three details in that netrc line are load-bearing: `$HOST` must have the **port stripped**, the values
must be **quoted**, and the variables are `OP_USER`/`OP_PASS` — the names Section 4 of
`auth-patterns.md` assigns. Never `$USER`: every login shell exports it, so it silently authenticates
as your OS username instead of failing. See gotchas #1 and #3.

Use `--reveal` when resolving credentials, and the documented `label=` selector:
`op item get "$ITEM" --fields "label=$FIELD" --reveal`. For a single field, `op read` is the
purpose-built command — 1Password's CLI reference for `item get` says "To retrieve the contents of a
specific field, use `op read` instead."

Note: Forgejo also accepts `Authorization: Bearer $TOKEN` for personal access tokens. Gitea's
documentation lists only the `token` prefix for them, so use `Authorization: token` for portability
across both. (OAuth2 access tokens are a different credential and require `Bearer` — see
`auth-patterns.md` Section 9.)

**Step 4:** Check the HTTP status code before treating credentials as valid. If credentials resolve but the API returns 401, re-read gotchas #1 and #3 before resetting passwords.

---

## Section 3: Making API Calls

Every API call follows this canonical pattern — no deviation:

```bash
response=$(curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  "${FORGEJO_URL}/api/v1/<endpoint>")
http_code=$(printf '%s\n' "$response" | tail -1)
body=$(printf '%s\n' "$response" | sed '$d')
[[ "$http_code" == "204" ]] && body=""

# Transport failure: curl emits only "\n000" and an empty body — not an HTTP error.
if [[ "$http_code" == "000" ]]; then
  echo "Network/TLS failure — server unreachable, no HTTP response" >&2
  exit 1
fi

# Always check status before parsing
if [[ "$http_code" != "200" && "$http_code" != "201" && "$http_code" != "204" ]]; then
  msg=$(printf '%s\n' "$body" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("message", "unknown"))
except Exception:
    print("non-JSON response")
')
  echo "API error $http_code: $msg" >&2
  exit 1
fi
```

The `try/except` is not decoration. With an empty body, a bare `json.load(sys.stdin)` raises
`JSONDecodeError` and dumps a multi-frame Python traceback to stderr; the `.get("message","unknown")`
default never fires, because the failure is in `json.load`, not the lookup.

**Input validation:** When constructing URLs from user-provided values (repo names, usernames, issue numbers), validate that they contain only alphanumeric characters, hyphens, underscores, and dots. Never interpolate unsanitized natural language input into shell commands.

**Error classification:**

| Code | Meaning | Action |
|------|---------|--------|
| 000 | No HTTP response | Network, DNS or TLS failure — the server was never reached. Not an auth problem. |
| 200/201/204 | Success | Parse body |
| 401 | Auth failure | Check credentials and token scopes — also check for shell escaping (gotcha #1/#3) |
| 403 | Forbidden | Check permissions and token scopes |
| 404 | Not found | Check URL construction and resource names |
| 409 | Conflict | Resource already exists — handle as idempotent, not error |
| 422 | Validation error | Check request body structure |
| 429 | Rate limited | Back off and retry |

---

## Section 4: Supported Operations

20 operations organized by tag. See `references/endpoints.md` for full curl patterns and body fields.

**Repos:**
- `POST /api/v1/user/repos` — create repo
- `GET /api/v1/user/repos` — list own repos
- `GET /api/v1/users/{username}/repos` — list user's repos
- `GET /api/v1/repos/{owner}/{repo}` — get repo
- `DELETE /api/v1/repos/{owner}/{repo}` — delete repo (DESTRUCTIVE)
- `GET /api/v1/repos/search?q={query}` — search repos

**Issues:**
- `GET /api/v1/repos/{owner}/{repo}/issues?type=issues&state=open` — list issues (note: without `?type=issues`, this endpoint returns both issues AND pull requests)
- `POST /api/v1/repos/{owner}/{repo}/issues` — create issue
- `POST /api/v1/repos/{owner}/{repo}/issues/{index}/comments` — comment on issue
- `PATCH /api/v1/repos/{owner}/{repo}/issues/{index}` — close/reopen issue

**Pull Requests:**
- `GET /api/v1/repos/{owner}/{repo}/pulls` — list PRs
- `POST /api/v1/repos/{owner}/{repo}/pulls` — create PR
- `POST /api/v1/repos/{owner}/{repo}/pulls/{index}/merge` — merge PR (DESTRUCTIVE)

**Users & Orgs:**
- `GET /api/v1/user` — get current user (auth verification)
- `POST /api/v1/orgs` — create org
- `GET /api/v1/orgs/{org}/repos` — list org repos

**Admin (read-only):**
- `GET /api/v1/admin/users` — list users

**Admin (DESTRUCTIVE — confirm before executing):**
- `POST /api/v1/admin/users` — create user

**Tokens (requires basic auth even with a token):**
- `POST /api/v1/users/{username}/tokens` — create API token
- `GET /api/v1/users/{username}/tokens` — list tokens

**Beyond the 20** — not part of the supported set, but present in both the Forgejo and Gitea specs
and needed for common flows (read-back/verify, org repos, file edits, token rotation). Full table in
`references/endpoints.md` under "Beyond the 20": `POST /api/v1/orgs/{org}/repos`,
`GET .../issues/{index}`, `GET .../pulls/{index}`, `GET .../issues/{index}/comments`,
`GET|PUT .../contents/{filepath}`, and `DELETE /api/v1/users/{username}/tokens/{token}` for
revocation. Rotation is create-new → verify with `GET /api/v1/user` → delete-old.

---

## Section 5: Pagination

Forgejo uses `page` + `limit` query params. The **`Link` response header is the terminator** —
Forgejo's API docs: "the `Link` header is returned with the next, previous, and last page links if
there are more than one page. The `x-total-count` is also returned to indicate the total number of
items."

**Page size is an instance setting, never a constant.** The config cheat sheet lists
`MAX_RESPONSE_ITEMS : 50` and `DEFAULT_PAGING_NUM : 30` as admin-tunable, and the docs say "The
default and maximum values for the page parameter can be obtained from the
`https://forgejo.example.org/api/v1/settings/api` endpoint", which returns
`{"max_response_items": 50, "default_paging_num": 30, ...}`. Never break the loop on
`count -lt 50`: on an instance configured with `MAX_RESPONSE_ITEMS=25`, page 1 returns 25 items, the
loop stops, and results 26..N vanish silently — the exact failure gotcha #8 exists to prevent.

```bash
if ! command -v jq >/dev/null 2>&1; then
  echo "Warning: jq not found — pagination disabled, only first page returned" >&2
fi

# Ask the instance for its own page size; fall back to the documented default.
LIMIT=$(curl -s --connect-timeout 10 --max-time 30 "${FORGEJO_URL}/api/v1/settings/api" \
  | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("max_response_items", 30))
except Exception:
    print(30)
')

page=1
all_results="[]"
hdr=$(mktemp "${TMPDIR:-/tmp}/fj-hdr.XXXXXX") || exit 1
trap 'rm -f "$hdr"' EXIT

while true; do
  [[ $page -gt 100 ]] && { echo "Warning: pagination exceeded 100 pages, stopping" >&2; break; }
  response=$(curl -s -D "$hdr" -w '\n%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    -H "Authorization: token $TOKEN" \
    "${FORGEJO_URL}/api/v1/<endpoint>?page=$page&limit=$LIMIT")
  http_code=$(printf '%s\n' "$response" | tail -1)
  body=$(printf '%s\n' "$response" | sed '$d')
  [[ "$http_code" != "200" ]] && { echo "Error $http_code" >&2; exit 1; }

  if ! command -v jq >/dev/null 2>&1; then
    all_results="$body"   # jq unavailable — first page only
    break
  fi

  # Normalize: search endpoints return {"data":[...],"ok":true}, lists return a bare array.
  page_items=$(printf '%s\n' "$body" | jq 'if type=="object" and has("data") then .data else . end') \
    || { echo "Error: page $page is not parseable JSON" >&2; exit 1; }
  all_results=$(jq -n --argjson a "$all_results" --argjson b "$page_items" '$a + $b') \
    || { echo "Error: could not merge page $page" >&2; exit 1; }
  count=$(printf '%s\n' "$page_items" | jq 'length')

  link_hdr=$(grep -i '^link:' "$hdr" || true)
  case "$link_hdr" in
    *'rel="next"'*) ;;                                  # more pages remain
    '')             if [ "$count" -eq 0 ]; then break; fi ;;  # no Link header — stop on empty page
    *)              break ;;                            # Link present without next — last page
  esac
  page=$((page + 1))
done
```

**The normalization line is not optional.** `/repos/search` returns an object, not an array, and
appending it to an array is a hard jq failure: `jq -n --argjson a '[]' --argjson b
'{"data":[{"id":1}],"ok":true}' '$a + $b'` prints
`jq: error: array ([]) and object cannot be added` and exits 5. Worse, `jq 'length'` on that same
object returns `2` (its key count), so a `count`-based break sees a small number, stops, and the
caller gets an empty result with no error at all. Both reproduced. Check jq's exit status — the
original loop swallowed it.

`grep` here reads a file rather than a pipe on purpose: `producer | grep -q …` under `set -o pipefail`
reports failure *because* the match succeeded (the producer dies of SIGPIPE, and pipefail propagates
141).

Note the deliberate cost: when a response carries **no** `Link` header at all (a single-page result),
the loop issues one extra request to see an empty page before stopping. Do not "optimize" that away
with `count -lt $LIMIT` — that is only sound when `$LIMIT` really came from the server, and the
`settings/api` fetch above has a fallback path where it did not. One redundant request is cheaper
than silently truncating a result set.

Verified end to end against a mock instance advertising `max_response_items: 25` with 57 items: the
loop collected 57 unique ids (0..56) from both the array-shaped and the object-shaped endpoint. The
old `count -lt 50` loop collected 25 of 57.

---

## Section 6: Gotchas

These 10 lessons are hard-won. Read carefully before debugging auth or API failures.

1. **Never `curl -u user:pass`** — use `--netrc-file` with process substitution. Passwords with special characters get shell-mangled before curl sees them. **Quote the netrc values**: netrc is whitespace-tokenized and has no escaping in the unquoted form, so `password pw with space` is silently truncated to `pw` (reproduced: the server decoded `alice:pw`). Quoted works: `--netrc-file <(printf 'machine %s login "%s" password "%s"\n' "$HOST" "$OP_USER" "$OP_PASS")` — curl supports quoted strings since 7.84.0, with `\"`, `\n`, `\r`, `\t` escapes, and they are "the only way a space character can be used in a username or password." Escape `\` and `"` in the values first (`netrc_esc` in `auth-patterns.md` Section 4). A space is the most common character in a generated passphrase, so this fires often.

2. **The 1Password display label may not be what `--fields` matches** — the setup form can rename fields (e.g. an "admin_confirm_passwd" label over a `password` field). Use the documented selector form, `--fields "label=password"`, and inspect the item with `op item get <item> --format json` when a lookup comes back empty. For a single field, 1Password's own reference points elsewhere: "To retrieve the contents of a specific field, use `op read` instead."

3. **"password is invalid" from Forgejo API often means shell escaping broke the password**, not that the password is wrong. Check the auth pattern before resetting credentials. **A 401 where `curl -v` shows no `Authorization:` line at all is a different bug**: the netrc `machine` token did not match the request host, so curl sent no credentials and warned about nothing. The usual cause is leaving the **port** on the machine name — `machine host:3000` never matches, while `machine host` does (reproduced: with the port, the server logged no `Authorization` header; without it, `Basic …`). Strip scheme, userinfo, port and path when deriving `$HOST`; keep the port in the request URL. Do not go debugging password escaping until you have confirmed a header was actually sent.

4. **Process substitution `<(…)` passes an open file descriptor**, not a temp file, on systems with `/dev/fd` — Linux and macOS, where this plugin runs. So there is no file to clean up and no race window. Bash falls back to a named FIFO where `/dev/fd` is unavailable (`man bash`: "Process substitution is supported on systems that support named pipes (FIFOs) or the /dev/fd method of naming open files"), so treat "never touches the filesystem" as a property of these platforms, not of the mechanism.

5. **Repo creation returns null fields on auth failure** — always check HTTP status code (`-w '%{http_code}'`) before parsing the response body. A 401 with null JSON looks like success until you try to use the repo URL.

6. **"repo already exists" is HTTP 409** — handle it gracefully, not as an error. In most workflows this is an idempotent condition, not a failure.

7. **`--exit-code` is not a valid `git ls-remote` flag** — it's a `git diff` flag. Common copy-paste error that produces a confusing "unknown switch" message. Encountered during Forgejo setup scripts that combine git and API calls.

8. **Pagination**: Forgejo uses `page` + `limit` query params. Terminate on the **`Link` header** (`rel="next"` absent = last page), which means you must actually capture headers — `curl -s` with no `-D`/`-i` reads none, so a loop that claims to use `x-total-count` while only reading the body is not doing what it says. Page size is an admin setting (`MAX_RESPONSE_ITEMS`, default 50; `DEFAULT_PAGING_NUM`, default 30) readable at `/api/v1/settings/api` — never hardcode it as a break condition. Always handle pagination for list operations or you silently miss results. See Section 5.

9. **2FA**: the OTP header **pairs with basic auth only** — in practice the token endpoints. Token-header auth is unaffected, so this is not something to add to "all requests". The header name is instance-flavored: `X-FORGEJO-OTP` on Forgejo, `X-GITEA-OTP` on Gitea. Both specs scope it identically — "Must be used in combination with BasicAuth if two-factor authentication is enabled." Read `securityDefinitions.TOTPHeader.name` from the instance's own `/swagger.v1.json` (Section 7) rather than hardcoding either name.

10. **Admin sudo**: act as another user via `?sudo=username` query parameter or `Sudo:` header. Requires an admin token — does not work with regular user tokens.

---

## Section 7: Discovery

For endpoints not in the supported 20, the Forgejo Swagger spec is the authoritative source.

Two things to know before writing the snippet:

- **Path keys carry no `/api/v1` prefix.** That prefix is the spec's top-level `basePath`. Verified on
  both public specs: 0 of 327 keys (Forgejo) and 0 of 308 (Gitea) start with `/api/v1` — real keys
  look like `/actions/run`. So `spec['paths']['/api/v1/…']` always raises `KeyError`, and a printed
  key pasted onto `$FORGEJO_URL` always 404s. Build request URLs as
  `${FORGEJO_URL}${basePath}${path}`.
- **The endpoint can be switched off**, and the fetch is subject to the same rules as any other call
  (gotcha #5, and Section 3's "no deviation"). `ENABLE_SWAGGER` is admin-toggleable, so pipe the
  status check first — otherwise a disabled endpoint and an unreachable host both surface as a raw
  `JSONDecodeError` traceback. The spec is ~859 KB, so the timeouts matter too.

```bash
KEYWORD="webhook"  # change this
response=$(curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  "${FORGEJO_URL}/swagger.v1.json")
http_code=$(printf '%s\n' "$response" | tail -1)
spec_body=$(printf '%s\n' "$response" | sed '$d')
if [[ "$http_code" != "200" ]]; then
  echo "Swagger unavailable (HTTP $http_code) — ENABLE_SWAGGER may be false; 000 means host unreachable" >&2
  exit 1
fi

# Find endpoints matching a keyword (prints full request paths)
printf '%s\n' "$spec_body" | python3 -c "
import json, sys
keyword = sys.argv[1]
try:
    spec = json.load(sys.stdin)
except ValueError:
    print('ERROR: swagger response was not JSON', file=sys.stderr); sys.exit(1)
base = spec.get('basePath', '/api/v1')
for path, methods in spec['paths'].items():
    if keyword in path or any(keyword in str(op) for op in methods.values()):
        print(base + path, sorted(m for m in methods if m in ('get','post','put','patch','delete')))
" "$KEYWORD"

# Get full operation details — note the key has NO /api/v1 prefix
printf '%s\n' "$spec_body" | python3 -c "
import json, sys
spec = json.load(sys.stdin)
print(json.dumps(spec['paths']['/user/repos'], indent=2))
"
```

Request-body schemas live under `definitions` (e.g. `spec['definitions']['MergePullRequestOption']`),
and `securityDefinitions.TOTPHeader.name` gives this instance's 2FA header name (gotcha #9).

Forgejo's web UI has a Swagger explorer at `<forgejo_url>/api/swagger`. Useful for interactive exploration before scripting.

---

## Section 8: Destructive Operations

For all DELETE methods, merge operations, and admin operations that modify or remove user, org, or repo state:

1. Tell the user what will happen in plain language
2. Show the exact curl command that will run (with credentials redacted — show `[TOKEN]` or `[PASSWORD]`)
3. Wait for explicit user confirmation ("yes", "proceed", "do it", etc.)
4. Execute only after confirmation is given

This applies even when the instruction seems unambiguous. Destructive operations are never batched or assumed. When in doubt, confirm.
