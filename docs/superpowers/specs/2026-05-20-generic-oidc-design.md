# Generic OIDC Provider for pgconsole

**Date:** 2026-05-20
**Status:** Approved, ready for implementation planning

## Problem

pgconsole currently supports SSO only via three hardcoded provider types: `google`, `keycloak`, `okta`. Each is a separate handler file (`server/lib/oauth/{google,keycloak,okta}.ts`) with hardcoded endpoint URL templates. This excludes any other OIDC-compliant IdP (Authelia, Auth0, Zitadel, Dex, AWS Cognito, Microsoft Entra, Pocket ID, etc.) without code changes.

Additionally, IdP group/role claims are ignored: group membership comes only from a static `[[groups]]` table in `pgconsole.toml` keyed by email. Adding a user to a group requires editing the TOML file and restarting the server.

## Goals

1. Replace the three hardcoded provider types with a single generic `oidc` provider type backed by OIDC discovery (`/.well-known/openid-configuration`).
2. Verify ID tokens via JWKS; always use PKCE.
3. Support optional IdP group claim → pgconsole group id mapping.
4. Support optional JIT user provisioning via a `default_policy` (list of pgconsole group ids). When unset, unknown SSO users are rejected (current behavior preserved).

## Non-goals

- SAML, SCIM
- Refresh tokens / silent renewal (keep current 7-day cookie model)
- Persistent JIT user storage (in-memory only; admin can promote to `[[users]]` for permanence)
- Logout federation (`end_session_endpoint`)
- Multiple simultaneous OIDC providers

## Constraints

- Pre-launch; no users yet. Breaking the existing `type = "google" | "keycloak" | "okta"` config is acceptable.
- No new plan-feature flag. OIDC SSO is ungated (works on FREE plan).

## Configuration shape

```toml
[[auth.providers]]
type = "oidc"
name = "Authelia"                            # display label on signin button
issuer_url = "https://auth.example.com"      # discovery base, no trailing slash
client_id = "pgconsole"
client_secret = "..."
scopes = ["openid", "email", "profile"]      # optional, defaults shown
groups_claim = "groups"                      # optional; if set, reads claim from ID token
group_mapping = { admins = "dba", devs = "developers" }   # optional; idp_group -> pgconsole_group_id

[auth.providers.default_policy]              # optional; when set, JIT-provision unknown SSO users
groups = ["viewers"]                         # pgconsole group ids granted to JIT users
```

**Validation rules:**

- `type`, `client_id`, `client_secret`, `issuer_url` required.
- Only one provider entry of `type = "oidc"` allowed; second one is a config error.
- `name` defaults to `"OIDC"` if omitted.
- `scopes` defaults to `["openid", "email", "profile"]`. `openid` is auto-added if missing.
- `groups_claim`, `group_mapping`, `default_policy` are optional.
- `default_policy.groups` entries must reference existing `[[groups]] id` values; unknown ids are a config error.
- `group_mapping` values must reference existing `[[groups]] id` values; unknown ids are a config error.
- `external_url` must be set (already enforced for any OAuth provider).

## Architecture

### File layout

```
server/lib/oauth/
├── oidc.ts         # NEW: registerOidcOAuth + handler
├── discovery.ts    # NEW: OidcDiscovery (well-known fetch + cache)
├── jwks.ts         # NEW: JwksVerifier (JWKS fetch + cache + token verify)
├── types.ts        # OAuthOpts (unchanged)
└── (google.ts, keycloak.ts, okta.ts)  # DELETED
```

`server/auth-routes.ts`:
- Drop `registerGoogleOAuth`, `registerKeycloakOAuth`, `registerOktaOAuth` imports + calls.
- Drop the three plan-gating middlewares for `/google`, `/keycloak`, `/okta`.
- Add one `registerOidcOAuth(router, oauthOpts)` call.
- `GET /api/auth/providers` returns `{ name: "oidc", displayName: "Authelia" }` style entries.

`server/lib/config.ts`:
- `AuthProviderConfig.type` becomes literally `'oidc'`.
- New optional fields: `name`, `scopes`, `groups_claim`, `group_mapping`, `default_policy`.
- Drop the `validProviderTypes = ['google', 'keycloak', 'okta']` allow-list.
- Validation enforces the rules above.

`src/lib/plan.ts`:
- Drop `SSO_GOOGLE`, `SSO_KEYCLOAK`, `SSO_OKTA` from `FEATURE_PLAN`.
- No new feature flag (ungated per decision).

### Components

#### `OidcDiscovery` (server/lib/oauth/discovery.ts)

Given `issuer_url`, fetches `/.well-known/openid-configuration` once and caches the result in module scope. Lazy: first request triggers the fetch. On failure, the failure is cached for 60 seconds (negative cache) to avoid hammering the IdP.

Exposes:
```ts
interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
  code_challenge_methods_supported?: string[]
}

async function getDiscovery(issuerUrl: string): Promise<DiscoveryDocument>
```

Throws `DiscoveryError` on network failure or missing required fields. Handler maps to `discovery_failed` redirect.

#### `JwksVerifier` (server/lib/oauth/jwks.ts)

Given `jwks_uri`, fetches JWKS and caches in module scope. On `kid` miss, refreshes once before failing.

Uses the `jose` library (add as dependency if not present).

Exposes:
```ts
interface VerifyOptions {
  expectedIssuer: string
  expectedAudience: string
  expectedNonce: string
}

async function verifyIdToken(
  idToken: string,
  jwksUri: string,
  options: VerifyOptions
): Promise<JwtPayload>
```

Throws `IdTokenError` for any verification failure. Handler maps to `id_token_invalid` redirect.

#### OIDC handler (server/lib/oauth/oidc.ts)

Two routes registered on the auth router:

**`GET /api/auth/oidc`**
1. Confirm OIDC provider is configured. If not, 400.
2. Generate `state` (32 bytes hex), `nonce` (32 bytes hex), and PKCE `code_verifier` (43-128 chars random) + `code_challenge` (`S256` of verifier).
3. Set three short-lived cookies: `pgconsole_oauth_state`, `pgconsole_oauth_nonce`, `pgconsole_oauth_pkce`. Each `httpOnly`, `sameSite=lax`, 10-minute max age, matching existing pattern.
4. Resolve discovery. If discovery fails, 503.
5. Redirect to `authorization_endpoint` with params: `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`.

**`GET /api/auth/oidc/callback`**
1. If query has `error`, redirect to `/signin?error=<error>` and clear cookies.
2. Validate state cookie matches query state. Else `invalid_state`.
3. Validate `code` is present. Else `no_code`.
4. Read nonce + PKCE cookies. Clear all three cookies.
5. Resolve discovery. On failure, `discovery_failed`.
6. POST to `token_endpoint` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`, `code_verifier`. Else `token_failed`.
7. Verify `id_token` via `JwksVerifier`. Else `id_token_invalid`.
8. Extract `email` from ID token claims. Else `no_email`.
9. Extract groups via `groups_claim` (if configured); apply `group_mapping`.
10. Resolve user via `resolveUser(email, mappedGroups)` (see Data flow below). On rejection, `user_not_allowed`.
11. Build display name: `given_name + family_name` ?? `name` ?? `email`.
12. Issue pgconsole JWT cookie carrying `email`, `name`, `idp: 'oidc'`, `groups: finalGroups`.
13. Audit `auth.login` with `provider: 'oidc'`. Redirect to `externalUrl`.

### Data flow: user resolution

```ts
function resolveUser(email: string, mappedIdpGroups: string[]): {
  email: string
  finalGroups: string[]
} | null {
  const staticUser = getUserByEmail(email)
  if (staticUser) {
    const staticGroups = getGroupsForUser(email).map(g => g.id)
    return { email, finalGroups: union(staticGroups, mappedIdpGroups) }
  }

  const policy = getOidcProvider().default_policy
  if (!policy) return null  // → user_not_allowed

  return { email, finalGroups: union(mappedIdpGroups, policy.groups) }
}
```

Display name is computed by the handler (step 11) from ID token claims, not by `resolveUser`.

Group resolution is **fixed for the session** (JWT lifetime, default 7d). Acceptable trade-off; simpler than re-resolving on every request.

### JWT payload extension

The current JWT payload includes `sub` (email), `name`, `avatar`. We add a `groups: string[]` field representing the resolved group set at login time.

Update `getGroupsForUser` consumers in `auth-routes.ts:/session` and any handler reading group membership to **prefer JWT-carried groups when present**, falling back to static lookup. This means basic-auth users still go through the static path (no JWT groups field, since basic auth resolves at request time — but for consistency we should also write groups into the JWT for basic-auth logins, computed via `getGroupsForUser`).

IAM evaluator (`server/lib/iam.ts`) already takes a user object; we feed it the JWT-carried groups so its logic remains unchanged.

### Error redirects

All callback errors redirect to `${externalUrl}/signin?error=<code>`:

| Code | Cause |
|---|---|
| `not_configured` | OIDC provider missing from config |
| `discovery_failed` | `.well-known/openid-configuration` fetch failed |
| `invalid_state` | State cookie missing or mismatch |
| `no_code` | Authorization code missing from callback |
| `token_failed` | Token endpoint returned non-2xx |
| `id_token_invalid` | ID token signature, issuer, audience, expiry, or nonce check failed |
| `no_email` | ID token missing email claim |
| `user_not_allowed` | User not in `[[users]]` and no `default_policy` set |
| `oauth_error` | Caught exception |

Discovery failures at startup are non-fatal (logged as warning); the `/api/auth/oidc` route returns 503 if discovery has never succeeded.

## Testing strategy

### Unit tests (no live IdP)

- `discovery.test.ts` — mock `fetch`. Cases: success, network error, malformed JSON, missing `authorization_endpoint`, cache hit, negative cache TTL.
- `jwks.test.ts` — generate signed test tokens with `jose`. Cases: valid token, expired, wrong issuer, wrong audience, wrong nonce, bad signature, unknown `kid` (triggers refresh), still-unknown `kid` after refresh.
- `oidc-handler.test.ts` — supertest against an Express app. Mock discovery, JWKS, token endpoint. Cases:
  - Happy path: pre-listed user, no group claim
  - Happy path: pre-listed user, group claim present, mapping applied (final groups = static ∪ mapped)
  - Happy path: JIT user with `default_policy.groups`
  - JIT user, claim has unmapped IdP group (silently dropped)
  - Unknown user, no `default_policy` → `user_not_allowed`
  - Each error path: `invalid_state`, `no_code`, `token_failed`, `id_token_invalid`, `no_email`
  - PKCE: verifier sent on token exchange, challenge in authorize URL
  - State + nonce cookies cleared after callback

### Integration test

`docs/features/sso.mdx` includes a verified Authelia docker-compose snippet for manual smoke testing. Not run in CI.

### Existing tests to update

Any test currently importing from `oauth/google.ts`, `oauth/keycloak.ts`, `oauth/okta.ts` is deleted along with those files. Tests for `auth-routes.ts` updated to remove plan-gating assertions for the dropped provider types.

## Migration / breaking changes

Pre-launch; no users yet.

- `type = "google" | "keycloak" | "okta"` configs become invalid → server fails to start with a clear error pointing to the new `oidc` type.
- `/api/auth/{google,keycloak,okta}*` routes are deleted.
- `SSO_GOOGLE`, `SSO_KEYCLOAK`, `SSO_OKTA` plan features are deleted.
- Documented in `CHANGELOG.md` and a new `docs/features/sso.mdx`.

## Open implementation questions (resolve during planning)

- Is `jose` already available? If not, add it. Avoid `jsonwebtoken` for verification — `jose` handles JWKS natively.
- Where to store the Discovery and JWKS caches: module-level `Map`s are sufficient given single-process deployment.
- Whether to expose a `/api/auth/oidc/discovery-status` health endpoint for ops. **Decision:** no — keep surface area minimal; logs cover this.
