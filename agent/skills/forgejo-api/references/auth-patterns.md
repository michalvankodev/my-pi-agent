# Auth Patterns — forgejo-cli

Complete, working authentication patterns for all 3 auth methods. Read this file when constructing curl commands that require authentication.

**Personal access tokens use `Authorization: token $TOKEN` on both Forgejo and Gitea.** OAuth2 access tokens are a different credential with a different header — see Section 9.

---

## Section 1: Config File Format

The config file lives at `~/.claude/forgejo-cli.local.md`. Claude reads it with the Read tool. It stores pointers to secrets — never secrets themselves. This file is gitignored and user-created at setup time.

```yaml
---
forgejo_url: https://forgejo.example.org
auth_method: token-cmd      # token-cmd | op | env
# token-cmd: any command that outputs a token to stdout
token_cmd: "op read op://<vault>/<item>/<field>"
# op: 1Password direct integration
op_item: my-forgejo
op_username_field: username   # matched by `--fields label=<value>`
op_password_field: password   # matched by `--fields label=<value>`
---
```

Inline `#` comments are supported by the parsers in Section 2, which strip them. Everything to the right of an unquoted `#` is discarded.

---

## Section 2: How Claude Reads the Config

Read the file with the Read tool, then parse fields using bash. Use this helper for **every** field — it bounds extraction to the frontmatter, strips inline comments, trims trailing whitespace, and unquotes:

```bash
CONFIG=~/.claude/forgejo-cli.local.md

fj_cfg() {
  # fj_cfg <field-name> — reads one field from the YAML frontmatter only
  sed -n '2,/^---$/p' "$CONFIG" \
    | grep "^$1:" | head -1 \
    | sed "s/^$1: *//" \
    | sed 's/[[:space:]]*#.*$//' \
    | sed 's/[[:space:]]*$//' \
    | sed 's/^["'"'"']\(.*\)["'"'"']$/\1/'
}

FORGEJO_URL=$(fj_cfg forgejo_url)
AUTH_METHOD=$(fj_cfg auth_method)
```

Why the helper rather than a bare `grep`: a bare `grep "^forgejo_url:"` on a config line reading
`forgejo_url: https://forgejo.example.org  # prod instance` yields the URL *with the comment glued
on*, and the resulting request URL is `https://forgejo.example.org  # prod instance/api/v1/user`.
The same bug on `token_cmd` passes the trailing comment into `eval`. Verified against a config
carrying inline comments on all three fields: the bare-grep form returned
`[https://forgejo.example.org  # prod instance]`, the helper returned `[https://forgejo.example.org]`.

**WARNING:** If content exists below the closing `---`, an unbounded `grep` matches lines in the body
and produces multi-line variable values. `eval` on a multi-line `TOKEN_CMD` executes multiple commands
with unpredictable results. The `sed -n '2,/^---$/p'` prefix in `fj_cfg` bounds extraction to the
frontmatter and removes that path entirely. Keep `.local.md` files frontmatter-only regardless.

---

## Section 3: token-cmd Auth (Happy Path)

The preferred method — works with any secret manager.

```bash
TOKEN_CMD=$(fj_cfg token_cmd)
[ -n "$TOKEN_CMD" ] || { echo "Error: token_cmd not set in config" >&2; exit 1; }

# Trust boundary: token_cmd is user-configured — it runs with the same privilege as any
# shell alias or .envrc command. The command value is logged (not the token) so the user
# can verify what is being invoked.
# SECURITY WARNING: Never accept token_cmd values from untrusted sources or third-party
# plugin configs. A compromised .local.md file enables arbitrary code execution at the
# privilege level of the Claude Code process.

# Resolve AND use the credential inside one trace-suppressed subshell.
( set +x
  TOKEN=$(eval "$TOKEN_CMD")
  [ -n "$TOKEN" ] || { echo "Error: token_cmd produced no output" >&2; exit 1; }
  curl -s -w '\n%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    -H @<(printf 'Authorization: token %s\n' "$TOKEN") \
    "${FORGEJO_URL}/api/v1/user"
)
```

**Why a subshell instead of save-and-restore.** The obvious idiom is wrong twice over:

```bash
TRACE_WAS_ON=false; [[ "$-" == *x* ]] && TRACE_WAS_ON=true
set +x
TOKEN=$(eval "$TOKEN_CMD")
$TRACE_WAS_ON && set -x        # <-- trace is back ON before the token is ever used
curl ... -H "Authorization: token $TOKEN"   # <-- under set -x, bash prints this expanded
```

The restore happens *before* the only line that expands the credential, so `set -x` prints the fully
expanded header to stderr — the leak the suppression existed to prevent. Separately,
`$TRACE_WAS_ON && set -x` evaluates to `false && …`, which returns 1; as the last statement of a
script or block that makes the whole invocation exit 1. Verified: a script ending in the `&&` form
exits 1, the same script ending in `if $TRACE_WAS_ON; then set -x; fi` exits 0. If you must keep the
save/restore dance, use the `if` form and put the restore *after* the curl.

**Why `-H @<(printf …)` instead of `-H "Authorization: token $TOKEN"`.** The inline form puts the
token in curl's argv, where any local user can read it. Verified by reading a live curl's
`/proc/<pid>/cmdline`: the inline form printed
`curl -s --max-time 6 -H Authorization: token sup3rsecret-token-value …`, while the header-file
form printed only `-H @/dev/fd/63`. `man curl`, `--header`: "This option can take an argument in
@filename style, which then adds a header for each line in the input file. Using @- makes curl read
the header file from stdin." `printf` is a shell builtin, so the token never becomes any process's
argv. Both forms were confirmed to deliver an identical `Authorization` header to a test server.

The inline `-H` form is used in `references/endpoints.md` for readability. It is fine on a
single-user workstation; prefer the header-file form on shared hosts and anywhere the command line
lands in a CI job log.

Note: log the token_cmd value (not the token) so the user can verify what's being called.

---

## Section 4: 1Password (op) Auth

Complete pattern for op auth — basic auth via process substitution.

```bash
OP_ITEM=$(fj_cfg op_item)
OP_USER_FIELD=$(fj_cfg op_username_field)
OP_PASS_FIELD=$(fj_cfg op_password_field)
: "${OP_USER_FIELD:=username}"
: "${OP_PASS_FIELD:=password}"

# Derive the netrc machine token: strip scheme, userinfo, port and path.
HOST=$(printf '%s\n' "$FORGEJO_URL" | sed -e 's|^https\?://||' -e 's|^[^@/]*@||' -e 's|[/:].*||')

# netrc quoted strings need \ and " escaped (curl 7.84.0+ supports quoting).
netrc_esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

( set +x
  OP_USER=$(op item get "$OP_ITEM" --fields "label=$OP_USER_FIELD" --reveal)
  OP_PASS=$(op item get "$OP_ITEM" --fields "label=$OP_PASS_FIELD" --reveal)
  [ -n "$OP_USER" ] && [ -n "$OP_PASS" ] || { echo "Error: op returned an empty credential" >&2; exit 1; }

  # Newlines cannot be represented even in a quoted netrc entry.
  case "$OP_USER$OP_PASS" in
    *$'\n'*) echo "Error: credential contains a newline — check the 1Password field" >&2; exit 1 ;;
  esac

  # CRITICAL: use --netrc-file with process substitution, NEVER curl -u
  curl -s -w '\n%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    --netrc-file <(printf 'machine %s login "%s" password "%s"\n' \
      "$HOST" "$(netrc_esc "$OP_USER")" "$(netrc_esc "$OP_PASS")") \
    "${FORGEJO_URL}/api/v1/user"
)
```

**Two traps this pattern exists to avoid — both reproduced against a local listener with curl 8.21.0:**

1. **The machine token must not carry the port.** `machine 127.0.0.1 login bob password s3cret` →
   the server received `Authorization: Basic Ym9iOnMzY3JldA==`. `machine 127.0.0.1:8731` with the
   same request → the server received **no `Authorization` header at all**, and curl exited 0 with no
   warning. A naive `sed 's|https\?://||' | sed 's|/.*||'` keeps the port, so every non-443 instance
   silently authenticates as nobody. Forgejo's stock docker-compose publishes port 3000. Keep the
   port in `$FORGEJO_URL` for the request URL; strip it only for `$HOST`.

2. **An unquoted netrc value is whitespace-tokenized.** `password pw with space` →
   `Basic YWxpY2U6cHc=`, which decodes to `alice:pw` — silently truncated at the first space.
   `password "pw with space"` → `Basic YWxpY2U6cHcgd2l0aCBzcGFjZQ==`, correct. everything.curl.dev's
   netrc page: "Each field is provided as a sequence of letters that ends with a space or newline.
   Since 7.84.0, curl also supports quoted strings. They start and end with double quotes ( `"` ) and
   support the escaped special letters `\"` , `\n` , `\r` , and `\t` . Quoted strings are the only way
   a space character can be used in a username or password."

   The `netrc_esc` helper above was verified to round-trip `simple`, `pw with space`, `has"quote`,
   `back\slash`, and `a b"c\d` — the server decoded each one byte-identically. On curl older than
   7.84.0 the quoted form is not available; there, reject the credential rather than truncate it:
   `case "$OP_PASS" in *[[:space:]]*) echo 'Error: credential contains whitespace — unquoted netrc cannot represent it' >&2; exit 1;; esac`

IMPORTANT: The process substitution `<(…)` MUST appear inline in the curl command. It cannot be
captured as a variable. This is why there is no auth helper script — Claude must construct the full
curl command directly.

---

## Section 5: env Var Auth

Least preferred — env vars visible to child processes.

```bash
TOKEN="${FORGEJO_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "Error: FORGEJO_TOKEN not set" >&2
  exit 1
fi
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H @<(printf 'Authorization: token %s\n' "$TOKEN") \
  "${FORGEJO_URL}/api/v1/user"
```

---

## Section 6: Canonical Curl Pattern

The template every API call follows — no deviation:

```bash
response=$(curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  <auth arguments inline here> \
  -H "Content-Type: application/json" \
  "${FORGEJO_URL}/api/v1/<endpoint>")
http_code=$(printf '%s\n' "$response" | tail -1)
body=$(printf '%s\n' "$response" | sed '$d')
[[ "$http_code" == "204" ]] && body=""

if [[ "$http_code" == "000" ]]; then
  echo "Network/TLS failure — server unreachable, no HTTP response" >&2
  exit 1
fi
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

The `try/except` is load-bearing. On connection refused, DNS failure or a TLS error,
`curl -s -w '\n%{http_code}'` emits only `\n000` — the body is empty, and a bare
`json.load(sys.stdin)` raises `json.decoder.JSONDecodeError: Expecting value` and dumps a
multi-frame traceback to stderr. The `.get("message","unknown")` default never fires, because the
failure is in `json.load`, not in the lookup. Verified by replaying the pipeline with an empty body.

Always check http_code before parsing body. Error classification:

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

## Section 7: Token Creation (Special Case)

Creating an API token always requires basic auth — even if you have a token already. Forgejo's API
docs: "Note that `/users/:name/tokens` is a special endpoint and requires you to authenticate using
BasicAuth and a password".

```bash
# Requires $HOST, netrc_esc, $OP_USER and $OP_PASS from Section 4.
( set +x
  response=$(curl -s -w '\n%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    --netrc-file <(printf 'machine %s login "%s" password "%s"\n' \
      "$HOST" "$(netrc_esc "$OP_USER")" "$(netrc_esc "$OP_PASS")") \
    -H "Content-Type: application/json" \
    -d '{"name":"my-token","scopes":["write:repository","write:issue"]}' \
    "${FORGEJO_URL}/api/v1/users/${OP_USER}/tokens")
  http_code=$(printf '%s\n' "$response" | tail -1)
  # Do NOT print the body — see below.
)
```

**Never echo the create-token response.** Forgejo's API docs, on that response: "The sha1 (the token)
is only returned once and is not stored in plain-text. It will not be displayed when listing tokens
with a GET request". This is the one moment the secret exists, and in a Claude Code plugin anything
printed to stdout lands in the session transcript. Pipe `.sha1` straight into whatever command stores
the secret, instead of into a shell variable a caller might later echo:

```bash
# STORE_CMD reads the token on stdin — e.g. a `pass insert`, a `secret-tool store`,
# or your 1Password item-creation command. Check its own docs for the exact flags.
STORE_CMD="cat >/dev/null"   # replace; the default deliberately discards

( set +x
  curl -s --connect-timeout 10 --max-time 30 \
    --netrc-file <(printf 'machine %s login "%s" password "%s"\n' \
      "$HOST" "$(netrc_esc "$OP_USER")" "$(netrc_esc "$OP_PASS")") \
    -H "Content-Type: application/json" \
    -d '{"name":"my-token","scopes":["write:repository","write:issue"]}' \
    "${FORGEJO_URL}/api/v1/users/${OP_USER}/tokens" \
  | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    print("ERROR: token creation returned non-JSON (check HTTP status)", file=sys.stderr)
    sys.exit(1)
if not d.get("sha1"):
    print("ERROR: no sha1 in response — token was not created", file=sys.stderr)
    sys.exit(1)
sys.stdout.write(d["sha1"])
' \
  | eval "$STORE_CMD"
)
```

The `try/except` and the `sha1` emptiness check both matter here: on a 401 the endpoint returns a
JSON error object with no `sha1`, and a bare `d["sha1"]` would raise `KeyError` after the traceback
has already printed the surrounding response.

**If the account has 2FA, this endpoint needs the OTP header** — it is the one endpoint Forgejo's own
docs demonstrate it on: `curl -H "X-Forgejo-OTP: 123456" --url https://{yourusername}:{yourpassword}@forgejo.example.org/api/v1/users/{username}/tokens`.
On Gitea the header is `X-Gitea-OTP`. See Section 8.

**Variable hygiene:** these snippets use `OP_USER` / `OP_PASS`, the names Section 4 assigns. Do not
substitute `$USER` — it is exported by every login shell, so it never trips an unset guard and
silently authenticates as your OS username. Guard before use:

```bash
: "${OP_USER:?resolve credentials via Section 4 first}"
: "${OP_PASS:?resolve credentials via Section 4 first}"
```

### Token hygiene

Forgejo's token-scope docs: "It is recommended to create the most restrictive access token possible
that meets a user's functional needs. If an access token is compromised in the future, a more
restrictive access token will have a smaller impact on a user's operations."

- Request the narrowest `read:` / `write:` pair the task needs. Read-only work wants
  `read:repository` / `read:issue`, not the `write:` scopes.
- Prefer a repository-scoped token where the instance supports it. Forgejo's docs: "Only the
  `read:repository` , `write:repository` , `read:issue` , and `write:issue` permissions can be used
  for a specific repository access token."
- **Revoke** with `DELETE /api/v1/users/{username}/tokens/{token}` (present in both the Forgejo and
  Gitea specs). Also basic auth.
- **Rotate** as create-new → verify with `GET /api/v1/user` → delete-old. Never delete first.

---

## Section 8: 2FA and Sudo Headers

```bash
# 2FA: pairs with BASIC AUTH only (the token endpoints). Token-header auth is unaffected.
-H "X-Forgejo-OTP: 123456"     # Forgejo
-H "X-Gitea-OTP: 123456"       # Gitea

# Admin sudo: act as another user
-H "Sudo: targetusername"
# or
"${FORGEJO_URL}/api/v1/endpoint?sudo=targetusername"
```

The OTP header is **scoped to basic auth**, and its name is instance-flavored. Both public swagger
specs say so directly: `securityDefinitions.TOTPHeader` is
`{"description": "Must be used in combination with BasicAuth if two-factor authentication is enabled.", "type": "apiKey", "name": "X-FORGEJO-OTP", "in": "header"}`
on code.forgejo.org, and identical except `"name": "X-GITEA-OTP"` on gitea.com. Read
`securityDefinitions.TOTPHeader.name` from the instance's own `/swagger.v1.json` (Section 9) rather
than hardcoding either name.

---

## Section 9: OAuth2 Access Tokens

An OAuth2 access token is **not** a personal access token and does not accept the same header.
Forgejo's API docs: "Access tokens obtained from Forgejo's OAuth2 provider are accepted by these
methods: `Authorization: Bearer ...` header in HTTP headers; `token=...` parameter in URL query
string; `access_token=...` parameter in URL query string." `Authorization: token` is not on that
list. Gitea's docs say the same for its own OAuth2 provider.

If `token_cmd` yields an OAuth2 access token rather than a personal access token, swap the header:

```bash
-H @<(printf 'Authorization: Bearer %s\n' "$TOKEN")
```

Do not use the `token=` / `access_token=` query-string forms — they put the credential in server and
proxy access logs.

For **personal access tokens**, keep `Authorization: token`. Forgejo accepts both `token` and
`Bearer` for these ("Forgejo supports these methods of API authentication: HTTP basic authentication;
`Authorization: Bearer ...` header in HTTP headers; `Authorization: token ...` header in HTTP
headers"), but Gitea's documented list for personal access tokens contains only the `token` prefix
("For historical reasons, Gitea needs the word token included before the API key token in an
authorization header"). `Authorization: token` is the portable choice across both.
