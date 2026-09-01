# Endpoints Reference — forgejo-cli

20 supported operations with exact endpoint, HTTP method, required request body fields, and example curl snippets. Organized by tag.

Use `$FORGEJO_URL` and `$TOKEN` as placeholders — replace with real values from config and resolved auth.

The examples below use the inline `-H "Authorization: token $TOKEN"` form for readability. That form
leaves the token in curl's argv, visible in `ps` and `/proc/<pid>/cmdline`. On a shared host or in
CI, use the header-file form from `references/auth-patterns.md` Section 3 instead:
`-H @<(printf 'Authorization: token %s\n' "$TOKEN")`.

---

## Repos (6 operations)

### 1. Create repo

`POST /api/v1/user/repos`

Body: `{"name":"<repo>","private":true|false,"description":"<optional>","auto_init":true|false}`

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"myrepo","private":true,"auto_init":false}' \
  "${FORGEJO_URL}/api/v1/user/repos"
```

Returns HTTP 201 on success. HTTP 409 if repo already exists (idempotent — not an error).

### 2. List own repos

`GET /api/v1/user/repos?page=1&limit=50`

No body. Returns array of repo objects.

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/user/repos?page=1&limit=50"
```

### 3. List user's repos

`GET /api/v1/users/{username}/repos?page=1&limit=50`

No body.

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/users/someuser/repos?page=1&limit=50"
```

### 4. Get repo

`GET /api/v1/repos/{owner}/{repo}`

No body. Returns single repo object.

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/repos/owner/reponame"
```

### 5. Delete repo

`DELETE /api/v1/repos/{owner}/{repo}`

No body. Returns 204 on success.

**DESTRUCTIVE — requires user confirmation before executing.**

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -X DELETE \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/repos/owner/reponame"
```

### 6. Search repos

`GET /api/v1/repos/search?q={query}&limit=50`

No body. Returns `{"data": [...], "ok": true}`.

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/repos/search?q=myquery&limit=50"
```

---

## Issues (4 operations)

### 7. List issues

`GET /api/v1/repos/{owner}/{repo}/issues?type=issues&state=open&page=1&limit=50`

Query params: `type` (issues|pulls), `state` (open|closed|all), `labels`, `milestones`
(comma-separated milestone names), `assigned_by`, `created_by`, `mentioned_by`, `q` (search term),
`since`, `before`, `page`, `limit`. Forgejo additionally accepts `sort`; Gitea's spec does not list
it on this route.

**The filter is `milestones`, not `milestone`, and `assigned_by`, not `assignee`.** Verified against
both public swagger specs — code.forgejo.org (17.0.0-dev) lists
`['owner','repo','state','labels','q','type','milestones','since','before','created_by','assigned_by','mentioned_by','page','limit','sort']`
and gitea.com (1.27.0+dev) lists the same minus `sort`. Neither spec has a `milestone` or `assignee`
parameter on this endpoint.

An unrecognized query param is **ignored, not rejected**, so a typo'd filter returns HTTP 200 with
unfiltered results. Nothing tells you the filter did not apply — check the result count against the
unfiltered call if a filter appears to do nothing.

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/repos/owner/repo/issues?type=issues&state=open&page=1&limit=50"
```

### 8. Create issue

`POST /api/v1/repos/{owner}/{repo}/issues`

Body: `{"title":"<title>","body":"<optional>","assignees":[],"labels":[],"milestone":0}`

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Bug: something broke","body":"Description here"}' \
  "${FORGEJO_URL}/api/v1/repos/owner/repo/issues"
```

### 9. Comment on issue

`POST /api/v1/repos/{owner}/{repo}/issues/{index}/comments`

Body: `{"body":"<comment text>"}`

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"My comment here"}' \
  "${FORGEJO_URL}/api/v1/repos/owner/repo/issues/42/comments"
```

### 10. Close issue

`PATCH /api/v1/repos/{owner}/{repo}/issues/{index}`

Body: `{"state":"closed"}` (or `"open"` to reopen)

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -X PATCH \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"state":"closed"}' \
  "${FORGEJO_URL}/api/v1/repos/owner/repo/issues/42"
```

---

## Pull Requests (3 operations)

### 11. List PRs

`GET /api/v1/repos/{owner}/{repo}/pulls?state=open&page=1&limit=50`

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/repos/owner/repo/pulls?state=open&page=1&limit=50"
```

### 12. Create PR

`POST /api/v1/repos/{owner}/{repo}/pulls`

Body: `{"title":"<title>","head":"<branch>","base":"<target>","body":"<optional>"}`

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Fix the bug","head":"feature-branch","base":"main"}' \
  "${FORGEJO_URL}/api/v1/repos/owner/repo/pulls"
```

### 13. Merge PR

`POST /api/v1/repos/{owner}/{repo}/pulls/{index}/merge`

Body: `{"Do":"merge","MergeMessageField":"<optional>"}`

`Do` accepts six values, not four: `merge`, `rebase`, `rebase-merge`, `squash`, `fast-forward-only`,
`manually-merged`. Identical enum in both public specs.

**Returns HTTP 200 with an empty body** (`#/responses/empty` in both specs). Do not try to parse a
PR object out of the response — re-`GET` the PR if you need its post-merge state.

**Field names differ between the two forges.** Forgejo's `MergePullRequestOption` is
`['Do','MergeCommitID','MergeMessageField','MergeTitleField','delete_branch_after_merge','force_merge','head_commit_id','merge_when_checks_succeed']`
— the first four capitalized. Gitea 1.27.0+dev names all of them in snake_case:
`['delete_branch_after_merge','do','force_merge','head_commit_id','merge_commit_id','merge_message_field','merge_title_field','merge_when_checks_succeed']`.
Before sending any optional merge field, read `definitions.MergePullRequestOption` from the
instance's own `/swagger.v1.json` (see Swagger Discovery below) rather than guessing which spelling
that instance accepts.

**DESTRUCTIVE — requires user confirmation before executing.**

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"Do":"merge"}' \
  "${FORGEJO_URL}/api/v1/repos/owner/repo/pulls/7/merge"
```

---

## Users & Orgs (3 operations)

### 14. Get current user

`GET /api/v1/user`

No body. Good for auth verification.

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/user"
```

### 15. Create org

`POST /api/v1/orgs`

Body: `{"username":"<orgname>","visibility":"public|limited|private","description":"<optional>"}`

`visibility` has three values — the `CreateOrgOption.visibility` enum is `['public','limited','private']`
in both public specs. Other accepted fields: `full_name`, `website`, `location`, `email`,
`repo_admin_change_team_access`.

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"my-org","visibility":"private"}' \
  "${FORGEJO_URL}/api/v1/orgs"
```

### 16. List org repos

`GET /api/v1/orgs/{org}/repos?page=1&limit=50`

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/orgs/my-org/repos?page=1&limit=50"
```

---

## Admin — Read-only (1 operation)

### 17. List users

`GET /api/v1/admin/users?page=1&limit=50`

No body. Requires admin token. Returns array of user objects.

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/admin/users?page=1&limit=50"
```

---

## Admin — Destructive (1 operation) — DESTRUCTIVE — confirm before executing

### 18. Create user

`POST /api/v1/admin/users`

Body: `{"email":"<email>","username":"<username>","password":"<strong-random-password>","must_change_password":true,"source_id":0}`

NOTE: Generate a strong random password — do not hardcode a weak value. Use `openssl rand -base64 18` or similar, and communicate it to the admin out-of-band. `must_change_password: true` ensures the user sets their own password on first login.

**DESTRUCTIVE — requires user confirmation before executing.**

```bash
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.org","username":"newuser","password":"<generated-strong-password>","must_change_password":true,"source_id":0}' \
  "${FORGEJO_URL}/api/v1/admin/users"
```

---

## Tokens (2 operations)

Both token endpoints need **basic auth**, not a token. Forgejo's API docs: "Note that
`/users/:name/tokens` is a special endpoint and requires you to authenticate using BasicAuth and a
password" — and the same page demonstrates the GET listing with
`https://{yourusername}:{yourpassword}@forgejo.example.org/api/v1/users/{username}/tokens`.

The snippets below use `$OP_USER` / `$OP_PASS` / `$HOST` / `netrc_esc` exactly as
`references/auth-patterns.md` Section 4 defines them. Resolve credentials there first, and guard:
`: "${OP_USER:?resolve credentials first}"`. Do not substitute `$USER` — every login shell exports
it, so it silently authenticates as your OS username instead of failing.

If the account has 2FA, add `-H "X-Forgejo-OTP: <code>"` (Forgejo) or `-H "X-Gitea-OTP: <code>"`
(Gitea). These are the endpoints Forgejo's own docs demonstrate the OTP header on.

### 19. Create token

`POST /api/v1/users/{username}/tokens`

Body: `{"name":"<token-name>","scopes":["write:repository","write:issue"]}`

Request the narrowest scopes the task needs. Forgejo's token-scope docs: "It is recommended to create
the most restrictive access token possible that meets a user's functional needs. If an access token
is compromised in the future, a more restrictive access token will have a smaller impact on a user's
operations." Read-only work wants `read:repository` / `read:issue`. `write:user` is not needed by any
of the 20 operations here. For a repository-scoped token, note the restriction: "Only the
`read:repository` , `write:repository` , `read:issue` , and `write:issue` permissions can be used for
a specific repository access token."

**The response contains the only copy of the secret** — "The sha1 (the token) is only returned once
and is not stored in plain-text." Do not echo the body; in a Claude Code plugin that puts the token
in the session transcript. Pipe `.sha1` straight into the secret store (pattern in
`auth-patterns.md` Section 7).

```bash
( set +x
  curl -s -w '\n%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    --netrc-file <(printf 'machine %s login "%s" password "%s"\n' \
      "$HOST" "$(netrc_esc "$OP_USER")" "$(netrc_esc "$OP_PASS")") \
    -H "Content-Type: application/json" \
    -d '{"name":"my-token","scopes":["write:repository","write:issue"]}' \
    "${FORGEJO_URL}/api/v1/users/${OP_USER}/tokens"
)
```

### 20. List tokens

`GET /api/v1/users/{username}/tokens`

Also requires basic auth. `sha1` comes back empty for every entry — listing cannot recover a token.

```bash
( set +x
  curl -s -w '\n%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    --netrc-file <(printf 'machine %s login "%s" password "%s"\n' \
      "$HOST" "$(netrc_esc "$OP_USER")" "$(netrc_esc "$OP_PASS")") \
    "${FORGEJO_URL}/api/v1/users/${OP_USER}/tokens"
)
```

---

## Beyond the 20

These are not part of the supported 20 but are present in both the Forgejo 17.0.0-dev and
Gitea 1.27.0+dev specs, and close real gaps: without them an agent can create an issue but has no
documented way to read it back and verify, and cannot read a PR discussion before commenting.

| Operation | Endpoint | Notes |
|---|---|---|
| Create repo in an org | `POST /api/v1/orgs/{org}/repos` | Same `CreateRepoOption` body as #1. Pairs with #15 (create org), which otherwise has no follow-on. |
| Get one issue | `GET /api/v1/repos/{owner}/{repo}/issues/{index}` | Read-back/verify after #8 or #10. |
| Get one PR | `GET /api/v1/repos/{owner}/{repo}/pulls/{index}` | Check `mergeable` / state before #13. |
| List issue comments | `GET /api/v1/repos/{owner}/{repo}/issues/{index}/comments` | Read the thread before posting #9. |
| Get file contents | `GET /api/v1/repos/{owner}/{repo}/contents/{filepath}?ref=<branch>` | Returns base64 `content` plus the `sha`. |
| Create/update file | `PUT /api/v1/repos/{owner}/{repo}/contents/{filepath}` | base64 `content`; `sha` **required** when updating an existing file. Without this the only route to a file edit is a full clone. |
| Revoke a token | `DELETE /api/v1/users/{username}/tokens/{token}` | Basic auth, like #19/#20. The rotation path: create-new → verify with `GET /api/v1/user` → delete-old. |

```bash
# Read back an issue after creating it
curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: token $TOKEN" \
  "${FORGEJO_URL}/api/v1/repos/owner/repo/issues/42"
```

---

## Swagger Discovery (for operations beyond the 20)

For operations beyond the supported 20, discover endpoints from the instance itself.

**Path keys in the spec are NOT prefixed with `/api/v1`.** The prefix lives in the spec's top-level
`basePath`. Verified on both public specs: `basePath` is `/api/v1`, and 0 of 327 path keys (Forgejo)
and 0 of 308 (Gitea) begin with `/api/v1` — sample keys are `/actions/run`, `/activitypub/actor`.
So `spec['paths']['/api/v1/...']` always raises `KeyError`, and a printed key concatenated straight
onto `$FORGEJO_URL` always 404s. The request URL is `${FORGEJO_URL}${basePath}${path}`.

Swagger can also be turned off. Forgejo's config cheat sheet: "ENABLE_SWAGGER : true : Enables the
API documentation endpoints ( /api/swagger , /api/v1/swagger , …). True or false." Route these calls
through the canonical status-checked pattern so "swagger disabled" is distinguishable from "host
unreachable" — and keep the timeouts: the spec is ~859 KB, and an unreachable instance with no
`--max-time` hangs the Bash tool.

```bash
# List all endpoint paths matching a keyword
KEYWORD="webhook"  # change this
response=$(curl -s -w '\n%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  "${FORGEJO_URL}/swagger.v1.json")
http_code=$(printf '%s\n' "$response" | tail -1)
body=$(printf '%s\n' "$response" | sed '$d')
if [[ "$http_code" != "200" ]]; then
  echo "Swagger fetch failed (HTTP $http_code) — ENABLE_SWAGGER may be false, or the host is unreachable (000)" >&2
  exit 1
fi
printf '%s\n' "$body" | python3 -c "
import json, sys
keyword = sys.argv[1]
try:
    spec = json.load(sys.stdin)
except ValueError:
    print('ERROR: response was not JSON — swagger endpoint disabled or behind a login page', file=sys.stderr)
    sys.exit(1)
base = spec.get('basePath', '/api/v1')
for path, methods in spec['paths'].items():
    if keyword in path or any(keyword in str(op) for op in methods.values()):
        # request URL is \${FORGEJO_URL}<base><path>
        print(base + path, sorted(m for m in methods if m in ('get','post','put','patch','delete')))
" "$KEYWORD"

# Get full operation details including request body schema.
# NOTE the key has no /api/v1 prefix.
printf '%s\n' "$body" | python3 -c "
import json, sys
spec = json.load(sys.stdin)
op = spec['paths']['/user/repos']['post']
print(json.dumps(op, indent=2))
"
```

Request-body schemas live under `definitions` — e.g. `spec['definitions']['MergePullRequestOption']`
resolves the `$ref` that `/repos/{owner}/{repo}/pulls/{index}/merge` points at.

Also explore interactively at `<forgejo_url>/api/swagger`.
