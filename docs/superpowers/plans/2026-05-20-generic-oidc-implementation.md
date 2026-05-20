# Generic OIDC Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three hardcoded SSO provider types (`google`, `keycloak`, `okta`) with a single generic `oidc` provider that uses OIDC discovery, JWKS-based ID token verification, PKCE, optional IdP group claim mapping, and an optional `default_policy` for JIT user provisioning.

**Architecture:** New `server/lib/oauth/discovery.ts` (well-known fetch + cache), `server/lib/oauth/jwks.ts` (JWKS verifier), `server/lib/oauth/oidc.ts` (route handlers). Old `google.ts`, `keycloak.ts`, `okta.ts` deleted. `AuthProviderConfig` extended; plan-feature flags `SSO_GOOGLE/KEYCLOAK/OKTA` removed (OIDC ungated). Group resolution moves into the JWT payload at login time (final groups = static groups ∪ mapped IdP groups, plus `default_policy.groups` for JIT users).

**Tech Stack:** TypeScript, Express 5, jose@5 (already in deps), vitest, smol-toml.

**Spec:** `docs/superpowers/specs/2026-05-20-generic-oidc-design.md`

---

## File Structure

| File | Purpose | Action |
|---|---|---|
| `server/lib/oauth/discovery.ts` | OIDC discovery fetch + cache | Create |
| `server/lib/oauth/jwks.ts` | JWKS fetch + ID token verification | Create |
| `server/lib/oauth/oidc.ts` | `/api/auth/oidc` and `/api/auth/oidc/callback` handlers | Create |
| `server/lib/oauth/types.ts` | `OAuthOpts` interface | Unchanged |
| `server/lib/oauth/google.ts` | Old provider | Delete |
| `server/lib/oauth/keycloak.ts` | Old provider | Delete |
| `server/lib/oauth/okta.ts` | Old provider | Delete |
| `server/lib/config.ts` | Replace `AuthProviderConfig` with OIDC shape; add validation | Modify |
| `server/auth-routes.ts` | Remove old provider wiring; add OIDC; remove plan gates | Modify |
| `server/lib/auth.ts` | Add `groups` field to `TokenPayload` and `User`; change `idp` type | Modify |
| `src/lib/plan.ts` | Drop `SSO_GOOGLE/KEYCLOAK/OKTA` features | Modify |
| `tests/oauth-discovery.test.ts` | Discovery unit tests | Create |
| `tests/oauth-jwks.test.ts` | JWKS verifier unit tests | Create |
| `tests/oauth-oidc.test.ts` | OIDC handler integration tests | Create |
| `tests/iam.test.ts` | Update if it asserts on dropped feature flags | Modify if needed |
| `tests/plan.test.ts` | Update if it asserts on dropped feature flags | Modify if needed |
| `docs/features/sso.mdx` | New SSO docs (replaces per-provider docs) | Create |
| `pgconsole.toml` (root example) | Replace google/keycloak/okta examples with oidc | Modify if exists |
| `tests/pgconsole.test.toml` | Unchanged (no SSO in test config) | Unchanged |

---

## Task 1: Discovery module — types and skeleton

**Files:**
- Create: `server/lib/oauth/discovery.ts`
- Test: `tests/oauth-discovery.test.ts`

- [ ] **Step 1: Write failing test for the discovery interface**

Create `tests/oauth-discovery.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { getDiscovery, DiscoveryError, _resetDiscoveryCache } from '../server/lib/oauth/discovery'

describe('getDiscovery', () => {
  beforeEach(() => {
    _resetDiscoveryCache()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fetches and returns the discovery document', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: 'https://idp.example.com',
        authorization_endpoint: 'https://idp.example.com/authorize',
        token_endpoint: 'https://idp.example.com/token',
        userinfo_endpoint: 'https://idp.example.com/userinfo',
        jwks_uri: 'https://idp.example.com/jwks',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const doc = await getDiscovery('https://idp.example.com')
    expect(doc.issuer).toBe('https://idp.example.com')
    expect(doc.authorization_endpoint).toBe('https://idp.example.com/authorize')
    expect(fetchMock).toHaveBeenCalledWith('https://idp.example.com/.well-known/openid-configuration')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/oauth-discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement minimal discovery module**

Create `server/lib/oauth/discovery.ts`:

```ts
export interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
  code_challenge_methods_supported?: string[]
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscoveryError'
  }
}

interface CacheEntry {
  doc?: DiscoveryDocument
  error?: string
  expiresAt: number
}

const POSITIVE_TTL_MS = 60 * 60 * 1000 // 1 hour
const NEGATIVE_TTL_MS = 60 * 1000      // 1 minute

const cache = new Map<string, CacheEntry>()

export function _resetDiscoveryCache(): void {
  cache.clear()
}

export async function getDiscovery(issuerUrl: string): Promise<DiscoveryDocument> {
  const key = issuerUrl.replace(/\/+$/, '')
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) {
    if (cached.doc) return cached.doc
    if (cached.error) throw new DiscoveryError(cached.error)
  }

  const url = `${key}/.well-known/openid-configuration`
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    const msg = `Failed to fetch ${url}: ${(e as Error).message}`
    cache.set(key, { error: msg, expiresAt: now + NEGATIVE_TTL_MS })
    throw new DiscoveryError(msg)
  }
  if (!res.ok) {
    const msg = `Discovery fetch returned ${res.status} for ${url}`
    cache.set(key, { error: msg, expiresAt: now + NEGATIVE_TTL_MS })
    throw new DiscoveryError(msg)
  }

  const json = (await res.json()) as Partial<DiscoveryDocument>
  const required: (keyof DiscoveryDocument)[] = [
    'issuer',
    'authorization_endpoint',
    'token_endpoint',
    'userinfo_endpoint',
    'jwks_uri',
  ]
  for (const f of required) {
    if (typeof json[f] !== 'string') {
      const msg = `Discovery document missing required field: ${f}`
      cache.set(key, { error: msg, expiresAt: now + NEGATIVE_TTL_MS })
      throw new DiscoveryError(msg)
    }
  }

  const doc = json as DiscoveryDocument
  cache.set(key, { doc, expiresAt: now + POSITIVE_TTL_MS })
  return doc
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/oauth-discovery.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add server/lib/oauth/discovery.ts tests/oauth-discovery.test.ts
git commit -m "feat(oauth): add OIDC discovery module"
```

---

## Task 2: Discovery module — error and cache cases

**Files:**
- Modify: `tests/oauth-discovery.test.ts`

- [ ] **Step 1: Add failing tests for errors and caching**

Append to `tests/oauth-discovery.test.ts`:

```ts
describe('getDiscovery — errors and caching', () => {
  beforeEach(() => {
    _resetDiscoveryCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws DiscoveryError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(getDiscovery('https://idp.example.com')).rejects.toThrow(DiscoveryError)
  })

  it('throws DiscoveryError on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }))
    await expect(getDiscovery('https://idp.example.com')).rejects.toThrow(/404/)
  })

  it('throws DiscoveryError when required field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ issuer: 'https://x' }), // missing other required fields
    }))
    await expect(getDiscovery('https://idp.example.com')).rejects.toThrow(/authorization_endpoint/)
  })

  it('caches successful responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: 'https://idp.example.com',
        authorization_endpoint: 'https://idp.example.com/authorize',
        token_endpoint: 'https://idp.example.com/token',
        userinfo_endpoint: 'https://idp.example.com/userinfo',
        jwks_uri: 'https://idp.example.com/jwks',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await getDiscovery('https://idp.example.com')
    await getDiscovery('https://idp.example.com')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches errors and re-throws within TTL', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getDiscovery('https://idp.example.com')).rejects.toThrow(DiscoveryError)
    await expect(getDiscovery('https://idp.example.com')).rejects.toThrow(DiscoveryError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('strips trailing slashes from issuer URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: 'https://idp.example.com',
        authorization_endpoint: 'https://idp.example.com/authorize',
        token_endpoint: 'https://idp.example.com/token',
        userinfo_endpoint: 'https://idp.example.com/userinfo',
        jwks_uri: 'https://idp.example.com/jwks',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await getDiscovery('https://idp.example.com///')
    expect(fetchMock).toHaveBeenCalledWith('https://idp.example.com/.well-known/openid-configuration')
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm test tests/oauth-discovery.test.ts`
Expected: PASS (6 tests). All assertions should already work with the implementation from Task 1.

- [ ] **Step 3: Commit**

```bash
git add tests/oauth-discovery.test.ts
git commit -m "test(oauth): cover discovery error paths and caching"
```

---

## Task 3: JWKS verifier module

**Files:**
- Create: `server/lib/oauth/jwks.ts`
- Test: `tests/oauth-jwks.test.ts`

- [ ] **Step 1: Write the failing test scaffold**

Create `tests/oauth-jwks.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose'
import { verifyIdToken, IdTokenError, _resetJwksCache } from '../server/lib/oauth/jwks'

let privateKey: CryptoKey
let publicJwk: JWK
const KID = 'test-kid-1'

async function makeToken(claims: Record<string, unknown>, opts: { kid?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? KID })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

function mockJwksResponse(keys: JWK[]) {
  return {
    ok: true,
    json: async () => ({ keys }),
  }
}

beforeEach(async () => {
  _resetJwksCache()
  const { publicKey, privateKey: pk } = await generateKeyPair('RS256', { extractable: true })
  privateKey = pk
  publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verifyIdToken', () => {
  it('verifies a valid token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJwksResponse([publicJwk])))
    const token = await makeToken({
      iss: 'https://idp.example.com',
      aud: 'pgconsole',
      nonce: 'n1',
      email: 'a@example.com',
    })
    const payload = await verifyIdToken(token, 'https://idp.example.com/jwks', {
      expectedIssuer: 'https://idp.example.com',
      expectedAudience: 'pgconsole',
      expectedNonce: 'n1',
    })
    expect(payload.email).toBe('a@example.com')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/oauth-jwks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the JWKS verifier**

Create `server/lib/oauth/jwks.ts`:

```ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

export class IdTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdTokenError'
  }
}

export interface VerifyOptions {
  expectedIssuer: string
  expectedAudience: string
  expectedNonce: string
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function _resetJwksCache(): void {
  jwksCache.clear()
}

function getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(jwksUri)
  if (cached) return cached
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    cooldownDuration: 30_000, // 30s between refreshes on kid miss
    cacheMaxAge: 10 * 60_000, // 10 minutes
  })
  jwksCache.set(jwksUri, jwks)
  return jwks
}

export async function verifyIdToken(
  idToken: string,
  jwksUri: string,
  options: VerifyOptions
): Promise<JWTPayload> {
  const jwks = getJwks(jwksUri)
  let payload: JWTPayload
  try {
    const result = await jwtVerify(idToken, jwks, {
      issuer: options.expectedIssuer,
      audience: options.expectedAudience,
    })
    payload = result.payload
  } catch (e) {
    throw new IdTokenError(`ID token verification failed: ${(e as Error).message}`)
  }

  if (payload.nonce !== options.expectedNonce) {
    throw new IdTokenError('ID token nonce mismatch')
  }

  return payload
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/oauth-jwks.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add server/lib/oauth/jwks.ts tests/oauth-jwks.test.ts
git commit -m "feat(oauth): add JWKS-based ID token verifier"
```

---

## Task 4: JWKS verifier — failure cases

**Files:**
- Modify: `tests/oauth-jwks.test.ts`

- [ ] **Step 1: Add failing tests for verification failures**

Append to `tests/oauth-jwks.test.ts`:

```ts
describe('verifyIdToken — failure cases', () => {
  it('rejects expired tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJwksResponse([publicJwk])))
    const token = await new SignJWT({
      iss: 'https://idp.example.com',
      aud: 'pgconsole',
      nonce: 'n1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(privateKey)

    await expect(
      verifyIdToken(token, 'https://idp.example.com/jwks', {
        expectedIssuer: 'https://idp.example.com',
        expectedAudience: 'pgconsole',
        expectedNonce: 'n1',
      })
    ).rejects.toThrow(IdTokenError)
  })

  it('rejects wrong issuer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJwksResponse([publicJwk])))
    const token = await makeToken({
      iss: 'https://wrong.example.com',
      aud: 'pgconsole',
      nonce: 'n1',
    })
    await expect(
      verifyIdToken(token, 'https://idp.example.com/jwks', {
        expectedIssuer: 'https://idp.example.com',
        expectedAudience: 'pgconsole',
        expectedNonce: 'n1',
      })
    ).rejects.toThrow(IdTokenError)
  })

  it('rejects wrong audience', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJwksResponse([publicJwk])))
    const token = await makeToken({
      iss: 'https://idp.example.com',
      aud: 'someone-else',
      nonce: 'n1',
    })
    await expect(
      verifyIdToken(token, 'https://idp.example.com/jwks', {
        expectedIssuer: 'https://idp.example.com',
        expectedAudience: 'pgconsole',
        expectedNonce: 'n1',
      })
    ).rejects.toThrow(IdTokenError)
  })

  it('rejects wrong nonce', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJwksResponse([publicJwk])))
    const token = await makeToken({
      iss: 'https://idp.example.com',
      aud: 'pgconsole',
      nonce: 'wrong-nonce',
    })
    await expect(
      verifyIdToken(token, 'https://idp.example.com/jwks', {
        expectedIssuer: 'https://idp.example.com',
        expectedAudience: 'pgconsole',
        expectedNonce: 'n1',
      })
    ).rejects.toThrow(/nonce/)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `pnpm test tests/oauth-jwks.test.ts`
Expected: PASS (5 tests). The implementation from Task 3 already handles all these.

- [ ] **Step 3: Commit**

```bash
git add tests/oauth-jwks.test.ts
git commit -m "test(oauth): cover JWKS verifier failure cases"
```

---

## Task 5: Update auth types — groups in JWT, `idp` becomes string

**Files:**
- Modify: `server/lib/auth.ts`

- [ ] **Step 1: Update `TokenPayload` and `User` types**

Replace lines 5–17 of `server/lib/auth.ts` with:

```ts
export interface TokenPayload extends JWTPayload {
  sub: string // email
  name?: string // display name (only if different from sub)
  idp?: string // identity provider type (e.g. 'oidc'); omitted for basic auth
  avatar?: string
  groups?: string[] // resolved group ids at login time
}

export interface User {
  email: string
  name: string
  idp?: string // omitted for basic auth
  avatar?: string
  groups?: string[]
}
```

- [ ] **Step 2: Update `createToken` to emit `groups`**

Replace lines 39–69 of `server/lib/auth.ts` (the `createToken` function body) with:

```ts
export async function createToken(user: User): Promise<string> {
  const config = getAuthConfig()
  const expiration = parseExpiry(config?.signin_expiry ?? DEFAULT_SIGNIN_EXPIRY)

  const payload: TokenPayload = {
    sub: user.email,
  }

  if (user.name && user.name !== user.email) {
    payload.name = user.name
  }
  if (user.idp) {
    payload.idp = user.idp
  }
  if (user.avatar) {
    payload.avatar = user.avatar
  }
  if (user.groups && user.groups.length > 0) {
    payload.groups = user.groups
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('pgconsole')
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(getSecretKey())

  return token
}
```

- [ ] **Step 3: Update `getCurrentUser` to surface groups**

Replace lines 107–124 of `server/lib/auth.ts` with:

```ts
export async function getCurrentUser(req: Request): Promise<User | null> {
  const token = req.cookies?.[COOKIE_NAME]
  if (!token) return null

  const payload = await verifyToken(token)
  if (!payload) return null

  return {
    email: payload.sub,
    name: payload.name || payload.sub,
    idp: payload.idp,
    avatar: payload.avatar,
    groups: payload.groups,
  }
}
```

- [ ] **Step 4: Verify build passes**

Run: `pnpm build:server`
Expected: SUCCESS. Type errors elsewhere referring to old `idp: 'google' | ...` literal type will be fixed in later tasks; if any surface here, note them and continue — they'll be fixed when those files are touched.

If build fails because something narrows on `idp === 'google'` etc., grep:
```bash
grep -rn "idp === 'google'\|idp === 'keycloak'\|idp === 'okta'" server src
```
Note any hits for later task adjustments. None expected based on current codebase.

- [ ] **Step 5: Commit**

```bash
git add server/lib/auth.ts
git commit -m "feat(auth): carry resolved group ids in JWT payload"
```

---

## Task 6: Update config types and validation

**Files:**
- Modify: `server/lib/config.ts`

- [ ] **Step 1: Replace `AuthProviderConfig` and add new types**

Replace lines 37–48 of `server/lib/config.ts` with:

```ts
export interface DefaultPolicy {
  groups: string[]
}

export interface AuthProviderConfig {
  type: 'oidc'
  name?: string
  client_id: string
  client_secret: string
  issuer_url: string
  scopes?: string[]
  groups_claim?: string
  group_mapping?: Record<string, string>
  default_policy?: DefaultPolicy
}

export interface AuthConfig {
  jwt_secret: string
  signin_expiry?: string
  providers: AuthProviderConfig[]
}
```

- [ ] **Step 2: Replace provider parsing block**

Replace lines 442–474 of `server/lib/config.ts` (everything inside `if (parsed.auth) { ... }` that handles `rawProviders`) with:

```ts
    // Parse [[auth.providers]] array
    const providers: AuthProviderConfig[] = []
    const rawProviders = a.providers as unknown[] | undefined
    if (rawProviders && Array.isArray(rawProviders)) {
      let oidcCount = 0
      for (const entry of rawProviders) {
        const raw = entry as Record<string, unknown>

        if (!raw.type || typeof raw.type !== 'string') {
          throw new Error('Auth provider missing required field: type')
        }
        if (raw.type !== 'oidc') {
          throw new Error(
            `Auth provider has invalid type: ${raw.type}. Only "oidc" is supported. ` +
            `(google, keycloak, okta were removed in favor of generic OIDC.)`
          )
        }
        oidcCount++
        if (oidcCount > 1) {
          throw new Error('Only one [[auth.providers]] entry of type "oidc" is allowed')
        }

        if (!raw.client_id || typeof raw.client_id !== 'string') {
          throw new Error('oidc provider missing required field: client_id')
        }
        if (!raw.client_secret || typeof raw.client_secret !== 'string') {
          throw new Error('oidc provider missing required field: client_secret')
        }
        if (!raw.issuer_url || typeof raw.issuer_url !== 'string') {
          throw new Error('oidc provider missing required field: issuer_url')
        }

        const provider: AuthProviderConfig = {
          type: 'oidc',
          client_id: raw.client_id,
          client_secret: raw.client_secret,
          issuer_url: raw.issuer_url.replace(/\/+$/, ''),
        }

        if (raw.name !== undefined) {
          if (typeof raw.name !== 'string' || !raw.name.trim()) {
            throw new Error('oidc provider name must be a non-empty string')
          }
          provider.name = raw.name.trim()
        }

        if (raw.scopes !== undefined) {
          if (!Array.isArray(raw.scopes) || raw.scopes.some((s) => typeof s !== 'string')) {
            throw new Error('oidc provider scopes must be an array of strings')
          }
          const scopes = (raw.scopes as string[]).map((s) => s.trim()).filter((s) => s.length > 0)
          if (!scopes.includes('openid')) scopes.unshift('openid')
          provider.scopes = scopes
        }

        if (raw.groups_claim !== undefined) {
          if (typeof raw.groups_claim !== 'string' || !raw.groups_claim.trim()) {
            throw new Error('oidc provider groups_claim must be a non-empty string')
          }
          provider.groups_claim = raw.groups_claim.trim()
        }

        if (raw.group_mapping !== undefined) {
          if (
            typeof raw.group_mapping !== 'object' ||
            raw.group_mapping === null ||
            Array.isArray(raw.group_mapping)
          ) {
            throw new Error('oidc provider group_mapping must be a table of string=string pairs')
          }
          const mapping: Record<string, string> = {}
          for (const [k, v] of Object.entries(raw.group_mapping as Record<string, unknown>)) {
            if (typeof v !== 'string') {
              throw new Error(`oidc provider group_mapping["${k}"] must be a string`)
            }
            mapping[k] = v
          }
          provider.group_mapping = mapping
        }

        if (raw.default_policy !== undefined) {
          const dp = raw.default_policy as Record<string, unknown>
          if (typeof dp !== 'object' || dp === null || Array.isArray(dp)) {
            throw new Error('oidc provider default_policy must be a table')
          }
          if (!Array.isArray(dp.groups) || dp.groups.some((g) => typeof g !== 'string')) {
            throw new Error('oidc provider default_policy.groups must be an array of strings')
          }
          provider.default_policy = { groups: dp.groups as string[] }
        }

        providers.push(provider)
      }
    }
```

- [ ] **Step 3: Add cross-validation of group references**

After the provider loop closes and before the `// Validate external_url is set...` line (around the existing line 477), insert:

```ts
    // Cross-validate group references in OIDC config against [[groups]]
    for (const provider of providers) {
      if (provider.group_mapping) {
        for (const [idpGroup, pgGroup] of Object.entries(provider.group_mapping)) {
          if (!seenGroupIds.has(pgGroup)) {
            throw new Error(
              `oidc provider group_mapping["${idpGroup}"] references unknown pgconsole group: ${pgGroup}`
            )
          }
        }
      }
      if (provider.default_policy) {
        for (const g of provider.default_policy.groups) {
          if (!seenGroupIds.has(g)) {
            throw new Error(
              `oidc provider default_policy.groups references unknown pgconsole group: ${g}`
            )
          }
        }
      }
    }
```

Note: `seenGroupIds` is defined earlier in `parseConfig`; verify the variable name with `grep -n seenGroupIds server/lib/config.ts` before writing — adjust if needed.

- [ ] **Step 4: Add `getOidcProvider` accessor**

After `getAuthProvider` (around line 667) add:

```ts
export function getOidcProvider(): AuthProviderConfig | undefined {
  return loadedConfig.auth?.providers.find((p) => p.type === 'oidc')
}
```

You may also leave `getAuthProvider` in place — it still works since `type` is `'oidc'` only — but consider removing it in Task 8 if it has no callers besides the deleted handlers.

- [ ] **Step 5: Verify config still type-checks**

Run: `pnpm build:server`
Expected: build fails because `server/lib/oauth/{google,keycloak,okta}.ts` still reference `getAuthProvider('google'|'keycloak'|'okta')`. That is fine — those files will be deleted in Task 8. Note the failures and continue.

- [ ] **Step 6: Commit (broken intermediate state)**

```bash
git add server/lib/config.ts
git commit -m "feat(config): replace per-provider auth types with generic OIDC"
```

(Repo will not type-check until Task 8 lands; commit anyway so tasks remain bite-sized.)

---

## Task 7: Drop `SSO_*` plan features

**Files:**
- Modify: `src/lib/plan.ts`

- [ ] **Step 1: Remove the three SSO features from `FEATURE_PLAN`**

Replace lines 9–18 of `src/lib/plan.ts` with:

```ts
const FEATURE_PLAN = {
  GROUPS: 'TEAM',
  IAM: 'TEAM',
  BANNER: 'TEAM',
  BRANDING: 'ENTERPRISE',
  AUDIT_LOG: 'ENTERPRISE',
} as const
```

- [ ] **Step 2: Update plan tests if they assert on dropped features**

Run: `pnpm test tests/plan.test.ts`

If tests fail because they reference `SSO_GOOGLE`, `SSO_KEYCLOAK`, or `SSO_OKTA`, edit `tests/plan.test.ts` to remove those assertions. (Do not add new assertions for OIDC since OIDC is intentionally ungated.)

Run again: `pnpm test tests/plan.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/plan.ts tests/plan.test.ts
git commit -m "feat(plan): drop SSO_GOOGLE/KEYCLOAK/OKTA feature flags"
```

---

## Task 8: Delete old OAuth handlers; remove from auth-routes

**Files:**
- Delete: `server/lib/oauth/google.ts`
- Delete: `server/lib/oauth/keycloak.ts`
- Delete: `server/lib/oauth/okta.ts`
- Modify: `server/auth-routes.ts`

- [ ] **Step 1: Delete the three handler files**

```bash
rm server/lib/oauth/google.ts server/lib/oauth/keycloak.ts server/lib/oauth/okta.ts
```

- [ ] **Step 2: Replace top of `server/auth-routes.ts`**

Replace lines 1–16 of `server/auth-routes.ts` with:

```ts
import { Router, type Request, type Response } from 'express'
import crypto from 'crypto'
import { createToken, verifyToken, authenticateBasic } from './lib/auth'
import { getAuthConfig, isAuthEnabled, getGroupsForUser, isOwner, getUsers, getOidcProvider } from './lib/config'
import { auditLogin, auditLogout } from './lib/audit'
import { registerOidcOAuth } from './lib/oauth/oidc'
```

- [ ] **Step 3: Remove plan-gating middlewares and old registration calls**

Delete lines 127–150 of `server/auth-routes.ts` (the three `router.use([...])` plan gates and the `registerGoogleOAuth/registerKeycloakOAuth/registerOktaOAuth` calls). Replace with:

```ts
registerOidcOAuth(router, oauthOpts)
```

- [ ] **Step 4: Update `/api/auth/providers` handler**

Replace lines 152–172 of `server/auth-routes.ts` (the `router.get('/providers', ...)` handler) with:

```ts
// GET /api/auth/providers
router.get('/providers', (_req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    return res.json({ providers: [] })
  }

  const providers: Array<{ name: string; displayName?: string }> = []
  if (getUsers().some((u) => u.password)) {
    providers.push({ name: 'basic' })
  }

  const oidc = getOidcProvider()
  if (oidc) {
    providers.push({ name: 'oidc', displayName: oidc.name ?? 'OIDC' })
  }

  return res.json({ providers })
})
```

- [ ] **Step 5: Update basic-auth login to populate groups**

Replace lines 60–72 (the `/login` handler body, specifically the part after `authenticateBasic`) with:

```ts
  const user = await authenticateBasic(email, password)
  const ip = getClientIp(req)
  if (!user) {
    auditLogin(email, 'basic', ip, false, 'Invalid credentials')
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  const groups = getGroupsForUser(user.email).map((g) => g.id)
  user.groups = groups

  const token = await createToken(user)
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS)
  auditLogin(user.email, 'basic', ip, true)
  return res.json({ user: { ...user, groups } })
```

- [ ] **Step 6: Update `/api/auth/session` to prefer JWT-carried groups**

Replace lines 92–101 (the section that reads `payload.sub` and resolves groups) with:

```ts
  const email = payload.sub
  const groups = payload.groups ?? getGroupsForUser(email).map((g) => g.id)

  return res.json({
    user: { email, name: payload.name || email, groups, avatar: payload.avatar },
    authEnabled: true,
    isOwner: isOwner(email),
  })
```

- [ ] **Step 7: Add stub `oidc.ts` so file builds**

Create a minimal `server/lib/oauth/oidc.ts` (full implementation comes next task):

```ts
import type { Router } from 'express'
import type { OAuthOpts } from './types'

export function registerOidcOAuth(_router: Router, _opts: OAuthOpts): void {
  // Implemented in Task 9
}
```

- [ ] **Step 8: Verify build now passes**

Run: `pnpm build:server`
Expected: SUCCESS.

- [ ] **Step 9: Commit**

```bash
git add server/lib/oauth/google.ts server/lib/oauth/keycloak.ts server/lib/oauth/okta.ts \
        server/auth-routes.ts server/lib/oauth/oidc.ts
git commit -m "refactor(auth): remove google/keycloak/okta handlers, wire OIDC stub"
```

---

## Task 9: OIDC handler — authorize route

**Files:**
- Modify: `server/lib/oauth/oidc.ts`
- Test: `tests/oauth-oidc.test.ts`

- [ ] **Step 1: Write failing test for the `/oidc` (authorize) route**

Create `tests/oauth-oidc.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { Router } from 'express'
import { registerOidcOAuth } from '../server/lib/oauth/oidc'
import * as config from '../server/lib/config'
import { _resetDiscoveryCache } from '../server/lib/oauth/discovery'

vi.mock('../server/lib/config', async () => {
  const actual = await vi.importActual<typeof import('../server/lib/config')>('../server/lib/config')
  return {
    ...actual,
    getOidcProvider: vi.fn(),
    getExternalUrl: vi.fn(),
    getUserByEmail: vi.fn(),
    getGroupsForUser: vi.fn(),
  }
})

const FAKE_DISCOVERY = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
  jwks_uri: 'https://idp.example.com/jwks',
}

function buildApp() {
  const app = express()
  app.use(cookieParser())
  const router = Router()
  registerOidcOAuth(router, {
    cookieName: 'pgconsole_token',
    cookieOptions: { httpOnly: true, path: '/' },
    stateCookie: 'pgconsole_oauth_state',
    stateCookieOptions: { httpOnly: true, path: '/' },
    generateState: () => 'state-fixed',
    getClientIp: () => '127.0.0.1',
  })
  app.use('/api/auth', router)
  return app
}

beforeEach(() => {
  _resetDiscoveryCache()
  vi.mocked(config.getExternalUrl).mockReturnValue('http://localhost:9876')
  vi.mocked(config.getOidcProvider).mockReturnValue({
    type: 'oidc',
    name: 'Test',
    client_id: 'pgconsole',
    client_secret: 'shh',
    issuer_url: 'https://idp.example.com',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/auth/oidc', () => {
  it('redirects to the IdP authorization endpoint with PKCE and state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => FAKE_DISCOVERY,
    }))

    const res = await request(buildApp()).get('/api/auth/oidc')
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.location)
    expect(loc.origin + loc.pathname).toBe('https://idp.example.com/authorize')
    expect(loc.searchParams.get('client_id')).toBe('pgconsole')
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:9876/api/auth/oidc/callback')
    expect(loc.searchParams.get('response_type')).toBe('code')
    expect(loc.searchParams.get('scope')).toContain('openid')
    expect(loc.searchParams.get('state')).toBe('state-fixed')
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
    const challenge = loc.searchParams.get('code_challenge')
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/) // base64url, 43 chars
    expect(loc.searchParams.get('nonce')).toMatch(/^[a-f0-9]{64}$/)

    const cookies = res.headers['set-cookie'] as unknown as string[]
    expect(cookies.some((c) => c.startsWith('pgconsole_oauth_state=state-fixed'))).toBe(true)
    expect(cookies.some((c) => c.startsWith('pgconsole_oauth_nonce='))).toBe(true)
    expect(cookies.some((c) => c.startsWith('pgconsole_oauth_pkce='))).toBe(true)
  })

  it('returns 400 when OIDC provider not configured', async () => {
    vi.mocked(config.getOidcProvider).mockReturnValue(undefined)
    const res = await request(buildApp()).get('/api/auth/oidc')
    expect(res.status).toBe(400)
  })

  it('returns 503 when discovery fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const res = await request(buildApp()).get('/api/auth/oidc')
    expect(res.status).toBe(503)
  })
})
```

Add `supertest` to dev deps if not present:

```bash
pnpm add -D supertest @types/supertest
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/oauth-oidc.test.ts`
Expected: FAIL — registerOidcOAuth is a stub, route doesn't exist.

- [ ] **Step 3: Implement the authorize route**

Replace `server/lib/oauth/oidc.ts` with:

```ts
import type { Router, Request, Response } from 'express'
import crypto from 'crypto'
import { createToken, type User } from '../auth'
import { getOidcProvider, getExternalUrl, getUserByEmail, getGroupsForUser } from '../config'
import { auditLogin } from '../audit'
import { getDiscovery, DiscoveryError } from './discovery'
import { verifyIdToken, IdTokenError } from './jwks'
import type { OAuthOpts } from './types'

const NONCE_COOKIE = 'pgconsole_oauth_nonce'
const PKCE_COOKIE = 'pgconsole_oauth_pkce'

const DEFAULT_SCOPES = ['openid', 'email', 'profile']

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generateRandomString(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex')
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(32)) // 43 chars
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function registerOidcOAuth(router: Router, opts: OAuthOpts): void {
  // GET /api/auth/oidc — start authorization
  router.get('/oidc', async (_req: Request, res: Response) => {
    const oidc = getOidcProvider()
    if (!oidc) {
      return res.status(400).json({ error: 'OIDC not configured' })
    }
    const externalUrl = getExternalUrl()!

    let discovery
    try {
      discovery = await getDiscovery(oidc.issuer_url)
    } catch (e) {
      console.warn(`OIDC discovery failed: ${(e as Error).message}`)
      return res.status(503).json({ error: 'OIDC discovery failed' })
    }

    const state = opts.generateState()
    const nonce = generateRandomString(32)
    const { verifier, challenge } = generatePkce()

    res.cookie(opts.stateCookie, state, opts.stateCookieOptions)
    res.cookie(NONCE_COOKIE, nonce, opts.stateCookieOptions)
    res.cookie(PKCE_COOKIE, verifier, opts.stateCookieOptions)

    const scopes = oidc.scopes && oidc.scopes.length > 0 ? oidc.scopes : DEFAULT_SCOPES
    const params = new URLSearchParams({
      client_id: oidc.client_id,
      redirect_uri: `${externalUrl}/api/auth/oidc/callback`,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    return res.redirect(`${discovery.authorization_endpoint}?${params}`)
  })

  // GET /api/auth/oidc/callback — implemented in Task 10
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test tests/oauth-oidc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib/oauth/oidc.ts tests/oauth-oidc.test.ts package.json pnpm-lock.yaml
git commit -m "feat(oauth): implement OIDC authorize route with PKCE"
```

---

## Task 10: OIDC handler — callback route (happy path)

**Files:**
- Modify: `server/lib/oauth/oidc.ts`
- Modify: `tests/oauth-oidc.test.ts`

- [ ] **Step 1: Write failing test for the happy-path callback**

Append to `tests/oauth-oidc.test.ts`:

```ts
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose'

describe('GET /api/auth/oidc/callback', () => {
  let privateKey: CryptoKey
  let publicJwk: JWK
  const KID = 'kid-1'

  beforeEach(async () => {
    const { publicKey, privateKey: pk } = await generateKeyPair('RS256', { extractable: true })
    privateKey = pk
    publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
  })

  async function makeIdToken(claims: Record<string, unknown> = {}) {
    return new SignJWT({
      iss: 'https://idp.example.com',
      aud: 'pgconsole',
      sub: 'idp-user-id',
      email: 'alice@example.com',
      given_name: 'Alice',
      family_name: 'Example',
      nonce: 'nonce-fixed',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  function mockIdpFetches(idToken: string) {
    return vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return { ok: true, json: async () => FAKE_DISCOVERY }
      }
      if (url === 'https://idp.example.com/jwks') {
        return { ok: true, json: async () => ({ keys: [publicJwk] }) }
      }
      if (url === 'https://idp.example.com/token') {
        return { ok: true, json: async () => ({ access_token: 'a', id_token: idToken }) }
      }
      throw new Error('unexpected fetch: ' + url)
    })
  }

  it('happy path: pre-listed user, no groups claim → static groups in JWT', async () => {
    vi.mocked(config.getUserByEmail).mockReturnValue({
      email: 'alice@example.com',
      owner: false,
    })
    vi.mocked(config.getGroupsForUser).mockReturnValue([
      { id: 'dba', name: 'DBAs', members: ['alice@example.com'] },
    ])
    // jwt_secret + signin_expiry come from real config; stub minimal auth
    vi.spyOn(config, 'getAuthConfig').mockReturnValue({
      jwt_secret: 'unit-test-secret-must-be-32-bytes-long-x',
      providers: [],
    })

    const idToken = await makeIdToken()
    vi.stubGlobal('fetch', mockIdpFetches(idToken))

    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'auth-code', state: 'state-fixed' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=verifier-fixed',
      ])

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('http://localhost:9876')

    const cookies = res.headers['set-cookie'] as unknown as string[]
    const tokenCookie = cookies.find((c) => c.startsWith('pgconsole_token='))
    expect(tokenCookie).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/oauth-oidc.test.ts -t "happy path"`
Expected: FAIL — callback route not implemented.

- [ ] **Step 3: Implement the callback route**

Append to `server/lib/oauth/oidc.ts` (inside `registerOidcOAuth`, before the closing brace):

```ts
  router.get('/oidc/callback', async (req: Request, res: Response) => {
    const oidc = getOidcProvider()
    const externalUrl = getExternalUrl()!

    if (!oidc) {
      return res.redirect(`${externalUrl}/signin?error=not_configured`)
    }

    const { error, code, state } = req.query

    // OAuth-level error
    if (error) {
      res.clearCookie(opts.stateCookie, { path: '/' })
      res.clearCookie(NONCE_COOKIE, { path: '/' })
      res.clearCookie(PKCE_COOKIE, { path: '/' })
      return res.redirect(`${externalUrl}/signin?error=${encodeURIComponent(String(error))}`)
    }

    // Read + clear state/nonce/pkce cookies
    const savedState = req.cookies?.[opts.stateCookie]
    const savedNonce = req.cookies?.[NONCE_COOKIE]
    const savedVerifier = req.cookies?.[PKCE_COOKIE]
    res.clearCookie(opts.stateCookie, { path: '/' })
    res.clearCookie(NONCE_COOKIE, { path: '/' })
    res.clearCookie(PKCE_COOKIE, { path: '/' })

    if (!state || !savedState || state !== savedState) {
      return res.redirect(`${externalUrl}/signin?error=invalid_state`)
    }
    if (!code || typeof code !== 'string') {
      return res.redirect(`${externalUrl}/signin?error=no_code`)
    }
    if (!savedNonce || !savedVerifier) {
      return res.redirect(`${externalUrl}/signin?error=invalid_state`)
    }

    let discovery
    try {
      discovery = await getDiscovery(oidc.issuer_url)
    } catch {
      return res.redirect(`${externalUrl}/signin?error=discovery_failed`)
    }

    // Token exchange
    let tokens: { id_token?: string; access_token?: string }
    try {
      const tokenRes = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${externalUrl}/api/auth/oidc/callback`,
          client_id: oidc.client_id,
          client_secret: oidc.client_secret,
          code_verifier: savedVerifier,
        }),
      })
      if (!tokenRes.ok) {
        return res.redirect(`${externalUrl}/signin?error=token_failed`)
      }
      tokens = (await tokenRes.json()) as { id_token?: string; access_token?: string }
    } catch {
      auditLogin('unknown', 'oidc', opts.getClientIp(req), false, 'token_exchange_error')
      return res.redirect(`${externalUrl}/signin?error=oauth_error`)
    }

    if (!tokens.id_token) {
      return res.redirect(`${externalUrl}/signin?error=token_failed`)
    }

    // Verify ID token
    let claims
    try {
      claims = await verifyIdToken(tokens.id_token, discovery.jwks_uri, {
        expectedIssuer: discovery.issuer,
        expectedAudience: oidc.client_id,
        expectedNonce: savedNonce,
      })
    } catch (e) {
      if (e instanceof IdTokenError || e instanceof DiscoveryError) {
        return res.redirect(`${externalUrl}/signin?error=id_token_invalid`)
      }
      return res.redirect(`${externalUrl}/signin?error=oauth_error`)
    }

    const email = typeof claims.email === 'string' ? claims.email : undefined
    if (!email) {
      return res.redirect(`${externalUrl}/signin?error=no_email`)
    }

    // Extract IdP groups via configured claim, then map to pgconsole group ids
    let mappedGroups: string[] = []
    if (oidc.groups_claim) {
      const raw = (claims as Record<string, unknown>)[oidc.groups_claim]
      if (Array.isArray(raw)) {
        const idpGroups = raw.filter((g): g is string => typeof g === 'string')
        if (oidc.group_mapping) {
          mappedGroups = idpGroups
            .map((g) => oidc.group_mapping![g])
            .filter((g): g is string => typeof g === 'string')
        } else {
          mappedGroups = idpGroups
        }
      }
    }

    // Resolve user
    const staticUser = getUserByEmail(email)
    let finalGroups: string[]
    if (staticUser) {
      const staticGroups = getGroupsForUser(email).map((g) => g.id)
      finalGroups = Array.from(new Set([...staticGroups, ...mappedGroups]))
    } else if (oidc.default_policy) {
      finalGroups = Array.from(new Set([...mappedGroups, ...oidc.default_policy.groups]))
    } else {
      auditLogin(email, 'oidc', opts.getClientIp(req), false, 'user_not_allowed')
      return res.redirect(`${externalUrl}/signin?error=user_not_allowed`)
    }

    // Build display name
    const givenName = typeof claims.given_name === 'string' ? claims.given_name : undefined
    const familyName = typeof claims.family_name === 'string' ? claims.family_name : undefined
    const fullName = typeof claims.name === 'string' ? claims.name : undefined
    const displayName = givenName && familyName ? `${givenName} ${familyName}` : fullName ?? email

    const user: User = {
      email,
      name: displayName,
      idp: 'oidc',
      groups: finalGroups,
    }

    const token = await createToken(user)
    res.cookie(opts.cookieName, token, opts.cookieOptions)
    auditLogin(email, 'oidc', opts.getClientIp(req), true)
    return res.redirect(externalUrl)
  })
```

- [ ] **Step 4: Run test to verify happy path passes**

Run: `pnpm test tests/oauth-oidc.test.ts -t "happy path"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/oauth/oidc.ts tests/oauth-oidc.test.ts
git commit -m "feat(oauth): implement OIDC callback with token exchange and user resolution"
```

---

## Task 11: OIDC callback — group mapping and JIT provisioning tests

**Files:**
- Modify: `tests/oauth-oidc.test.ts`

- [ ] **Step 1: Add tests for group claim mapping and JIT users**

Append to the `describe('GET /api/auth/oidc/callback', ...)` block in `tests/oauth-oidc.test.ts`:

```ts
  it('pre-listed user with groups claim — final groups = static ∪ mapped', async () => {
    vi.mocked(config.getOidcProvider).mockReturnValue({
      type: 'oidc',
      name: 'Test',
      client_id: 'pgconsole',
      client_secret: 'shh',
      issuer_url: 'https://idp.example.com',
      groups_claim: 'groups',
      group_mapping: { 'idp-admins': 'dba' },
    })
    vi.mocked(config.getUserByEmail).mockReturnValue({ email: 'alice@example.com', owner: false })
    vi.mocked(config.getGroupsForUser).mockReturnValue([
      { id: 'developers', name: 'Devs', members: ['alice@example.com'] },
    ])
    vi.spyOn(config, 'getAuthConfig').mockReturnValue({
      jwt_secret: 'unit-test-secret-must-be-32-bytes-long-x',
      providers: [],
    })

    const idToken = await makeIdToken({ groups: ['idp-admins', 'unmapped-group'] })
    vi.stubGlobal('fetch', mockIdpFetches(idToken))

    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'c', state: 'state-fixed' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=v',
      ])

    expect(res.status).toBe(302)
    // Decode the JWT cookie and inspect groups
    const cookies = res.headers['set-cookie'] as unknown as string[]
    const tokenCookie = cookies.find((c) => c.startsWith('pgconsole_token='))!
    const jwt = tokenCookie.split(';')[0].split('=')[1]
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    expect(payload.groups.sort()).toEqual(['dba', 'developers'])
  })

  it('JIT user via default_policy', async () => {
    vi.mocked(config.getOidcProvider).mockReturnValue({
      type: 'oidc',
      client_id: 'pgconsole',
      client_secret: 'shh',
      issuer_url: 'https://idp.example.com',
      default_policy: { groups: ['viewers'] },
    })
    vi.mocked(config.getUserByEmail).mockReturnValue(undefined)
    vi.spyOn(config, 'getAuthConfig').mockReturnValue({
      jwt_secret: 'unit-test-secret-must-be-32-bytes-long-x',
      providers: [],
    })

    const idToken = await makeIdToken()
    vi.stubGlobal('fetch', mockIdpFetches(idToken))

    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'c', state: 'state-fixed' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=v',
      ])

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('http://localhost:9876')
    const cookies = res.headers['set-cookie'] as unknown as string[]
    const tokenCookie = cookies.find((c) => c.startsWith('pgconsole_token='))!
    const jwt = tokenCookie.split(';')[0].split('=')[1]
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    expect(payload.groups).toEqual(['viewers'])
  })

  it('unknown user without default_policy → user_not_allowed', async () => {
    vi.mocked(config.getOidcProvider).mockReturnValue({
      type: 'oidc',
      client_id: 'pgconsole',
      client_secret: 'shh',
      issuer_url: 'https://idp.example.com',
    })
    vi.mocked(config.getUserByEmail).mockReturnValue(undefined)
    vi.spyOn(config, 'getAuthConfig').mockReturnValue({
      jwt_secret: 'unit-test-secret-must-be-32-bytes-long-x',
      providers: [],
    })

    const idToken = await makeIdToken()
    vi.stubGlobal('fetch', mockIdpFetches(idToken))

    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'c', state: 'state-fixed' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=v',
      ])

    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('error=user_not_allowed')
  })
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm test tests/oauth-oidc.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 3: Commit**

```bash
git add tests/oauth-oidc.test.ts
git commit -m "test(oauth): cover OIDC group mapping and JIT provisioning"
```

---

## Task 12: OIDC callback — error path tests

**Files:**
- Modify: `tests/oauth-oidc.test.ts`

- [ ] **Step 1: Add error-path tests**

Append to the callback `describe` block:

```ts
  it('invalid_state when state cookie missing', async () => {
    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'c', state: 'state-fixed' })
    expect(res.headers.location).toContain('error=invalid_state')
  })

  it('invalid_state when state mismatches', async () => {
    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'c', state: 'wrong' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=v',
      ])
    expect(res.headers.location).toContain('error=invalid_state')
  })

  it('no_code when code missing', async () => {
    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ state: 'state-fixed' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=v',
      ])
    expect(res.headers.location).toContain('error=no_code')
  })

  it('token_failed when token endpoint returns non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return { ok: true, json: async () => FAKE_DISCOVERY }
      }
      if (url === 'https://idp.example.com/token') {
        return { ok: false, status: 400, json: async () => ({}) }
      }
      throw new Error('unexpected: ' + url)
    }))

    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'c', state: 'state-fixed' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=v',
      ])
    expect(res.headers.location).toContain('error=token_failed')
  })

  it('id_token_invalid when nonce mismatches', async () => {
    vi.spyOn(config, 'getAuthConfig').mockReturnValue({
      jwt_secret: 'unit-test-secret-must-be-32-bytes-long-x',
      providers: [],
    })
    const idToken = await makeIdToken({ nonce: 'wrong-nonce' })
    vi.stubGlobal('fetch', mockIdpFetches(idToken))

    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'c', state: 'state-fixed' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=v',
      ])
    expect(res.headers.location).toContain('error=id_token_invalid')
  })

  it('no_email when ID token has no email claim', async () => {
    vi.spyOn(config, 'getAuthConfig').mockReturnValue({
      jwt_secret: 'unit-test-secret-must-be-32-bytes-long-x',
      providers: [],
    })
    const idToken = await new SignJWT({
      iss: 'https://idp.example.com',
      aud: 'pgconsole',
      sub: 'idp-user-id',
      nonce: 'nonce-fixed',
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)

    vi.stubGlobal('fetch', mockIdpFetches(idToken))

    const res = await request(buildApp())
      .get('/api/auth/oidc/callback')
      .query({ code: 'c', state: 'state-fixed' })
      .set('Cookie', [
        'pgconsole_oauth_state=state-fixed',
        'pgconsole_oauth_nonce=nonce-fixed',
        'pgconsole_oauth_pkce=v',
      ])
    expect(res.headers.location).toContain('error=no_email')
  })
```

- [ ] **Step 2: Run all OIDC tests**

Run: `pnpm test tests/oauth-oidc.test.ts`
Expected: PASS (all tests).

- [ ] **Step 3: Run full test suite to catch regressions**

Run: `pnpm test`
Expected: PASS. If any unrelated test fails because of the type changes (`idp` going from union to string, `groups` field added), fix per TDD: read the failure, update the test/code minimally.

- [ ] **Step 4: Commit**

```bash
git add tests/oauth-oidc.test.ts
git commit -m "test(oauth): cover OIDC callback error paths"
```

---

## Task 13: Update IAM evaluator to consume JWT-carried groups

**Files:**
- Modify: `server/lib/iam.ts`
- Test: existing `tests/iam.test.ts` should still pass

- [ ] **Step 1: Inspect current `iam.ts` to find the group-resolution call site**

Run:
```bash
grep -n "getGroupsForUser" server/lib/iam.ts
```

The function currently calls `getGroupsForUser(email)`. We need an alternative entry point that accepts an explicit groups list (so callers with JWT-carried groups can pass them through).

- [ ] **Step 2: Add `getUserPermissionsWithGroups` overload**

In `server/lib/iam.ts`, after the existing `getUserPermissions` function, add:

```ts
/**
 * Like getUserPermissions but accepts pre-resolved group ids
 * (e.g., from a JWT payload) instead of looking them up from static config.
 */
export function getUserPermissionsWithGroups(
  email: string,
  connectionId: string,
  groupIds: string[]
): Set<Permission> {
  if (!isAuthEnabled()) return new Set(ALL_PERMISSIONS)
  if (!feature('IAM', getPlan())) return new Set(ALL_PERMISSIONS)

  const perms = new Set<Permission>()
  for (const rule of getIAMRules()) {
    if (rule.connection !== '*' && rule.connection !== connectionId) continue
    if (!ruleMatches(rule, email, groupIds)) continue
    for (const p of rule.permissions) perms.add(p)
  }
  return perms
}
```

Where `ruleMatches(rule, email, groupIds)` is the same predicate used by `getUserPermissions` (extract it if not already a helper). If `getUserPermissions` is short, you can refactor it to call `getUserPermissionsWithGroups(email, connId, getGroupsForUser(email).map(g => g.id))`.

- [ ] **Step 3: Wire `getCurrentUser` callers to pass groups through**

Find call sites of `getUserPermissions(email, connId)`:

```bash
grep -rn "getUserPermissions\b" server/
```

For each call site that has access to a `User` object with `groups`, change the call to `getUserPermissionsWithGroups(user.email, connectionId, user.groups ?? [])`. Specifically check `server/services/connection-service.ts` and `server/services/query-service.ts` — they call `getUserFromContext` which returns the `User` from the JWT.

If a call site can't easily get the user object, leave it on the static path — the static lookup is still correct for users without JWT-carried groups (basic auth before this change).

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/iam.test.ts`
Expected: PASS. Existing tests use the static lookup path which is unchanged.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/iam.ts server/services/connection-service.ts server/services/query-service.ts
git commit -m "feat(iam): allow JWT-carried groups to drive permission resolution"
```

---

## Task 14: Update sign-in UI to use generic OIDC button

**Files:**
- Modify: `src/` files that render the sign-in page

- [ ] **Step 1: Find the sign-in page**

Run:
```bash
grep -rn "providers" src/ | grep -i "signin\|login" | head
```

Or:
```bash
grep -rn "/api/auth/providers\|/api/auth/google\|/api/auth/keycloak\|/api/auth/okta" src/
```

- [ ] **Step 2: Replace per-provider buttons with single OIDC button**

For each match, replace any logic like `if (provider.name === 'google') { ... }` with a generic case that:
- Renders a button labeled with `provider.displayName ?? 'Sign in with OIDC'` when `provider.name === 'oidc'`.
- Links to `/api/auth/oidc`.
- Removes any per-provider icon (Google / Keycloak / Okta logos) — generic OIDC has no canonical icon.

The handler in `server/auth-routes.ts` already returns `{ name: "oidc", displayName: "Authelia" }` style entries from Task 8. Use both fields in the UI.

Show actual code change:

```tsx
// BEFORE (illustrative — actual code may differ)
{providers.map((p) => {
  if (p.name === 'google') return <GoogleButton key={p.name} />
  if (p.name === 'keycloak') return <KeycloakButton key={p.name} />
  if (p.name === 'okta') return <OktaButton key={p.name} />
  return null
})}

// AFTER
{providers.map((p) => {
  if (p.name === 'basic') return null // basic uses the email/password form
  if (p.name === 'oidc') {
    return (
      <a key={p.name} href="/api/auth/oidc" className="...">
        Sign in with {p.displayName ?? 'OIDC'}
      </a>
    )
  }
  return null
})}
```

- [ ] **Step 3: Verify build and TypeScript**

Run: `pnpm build`
Expected: SUCCESS.

- [ ] **Step 4: Manual smoke test (optional but recommended)**

Run: `pnpm dev` with a `pgconsole.toml` that has an `oidc` provider pointing at any reachable IdP. Visit signin page, confirm button appears with correct label and links to `/api/auth/oidc`.

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "feat(ui): replace per-provider sign-in buttons with generic OIDC"
```

---

## Task 15: Documentation

**Files:**
- Create: `docs/features/sso.mdx`
- Modify: `docs/docs.json` (sidebar entry)
- Delete: any `docs/features/sso-google.mdx`, `docs/features/sso-keycloak.mdx`, `docs/features/sso-okta.mdx` if they exist

- [ ] **Step 1: Find and remove old per-provider docs**

```bash
ls docs/features/ | grep -iE 'google|keycloak|okta'
```

Delete any matches:

```bash
rm docs/features/sso-google.mdx docs/features/sso-keycloak.mdx docs/features/sso-okta.mdx 2>/dev/null
```

- [ ] **Step 2: Create `docs/features/sso.mdx`**

```mdx
---
title: SSO (OIDC)
---

pgconsole supports single sign-on through any OpenID Connect-compliant identity provider, including Authelia, Keycloak, Okta, Auth0, Zitadel, Dex, AWS Cognito, Microsoft Entra ID, Google, and Pocket ID.

## Configuration

Add an OIDC provider to your `pgconsole.toml`:

```toml
[general]
external_url = "https://pgconsole.example.com"

[auth]
jwt_secret = "<at least 32 random characters>"

[[auth.providers]]
type = "oidc"
name = "Authelia"                            # Label on the sign-in button
issuer_url = "https://auth.example.com"      # IdP base URL (no trailing slash)
client_id = "pgconsole"
client_secret = "..."
scopes = ["openid", "email", "profile"]      # Optional, defaults shown
```

The redirect URI to register at your IdP is:

```
https://pgconsole.example.com/api/auth/oidc/callback
```

## Group claim mapping

If your IdP issues a groups claim in the ID token, you can map IdP groups to pgconsole groups:

```toml
[[auth.providers]]
type = "oidc"
# ...
groups_claim = "groups"
group_mapping = { "idp-admins" = "dba", "idp-devs" = "developers" }
```

The user's pgconsole group membership becomes the union of:
1. Static memberships in `[[groups]] members` keyed by email.
2. Mapped IdP groups present in the ID token.

Group membership is fixed for the JWT's lifetime (default 7 days). Re-login picks up changes.

## JIT user provisioning

By default, an SSO user must be pre-listed in `[[users]]` or login is rejected. To allow unknown users to sign in, define a `default_policy`:

```toml
[[auth.providers.default_policy]]
groups = ["viewers"]
```

When set, an unknown SSO user is provisioned in-memory on first login. They are treated as a member of `default_policy.groups` (combined with any mapped IdP groups). They are not persisted to `pgconsole.toml` — the next login recreates them. Their access is whatever IAM rules apply via those groups.

## Authelia example

Authelia client registration:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: pgconsole
        client_secret: '$pbkdf2-sha512$...'
        public: false
        redirect_uris:
          - https://pgconsole.example.com/api/auth/oidc/callback
        scopes:
          - openid
          - email
          - profile
          - groups
        userinfo_signing_algorithm: none
```

Then in `pgconsole.toml`:

```toml
[[auth.providers]]
type = "oidc"
name = "Authelia"
issuer_url = "https://auth.example.com"
client_id = "pgconsole"
client_secret = "<plaintext-of-the-pbkdf2-secret>"
groups_claim = "groups"
group_mapping = { admins = "dba" }
```

## Security notes

- pgconsole always uses PKCE (S256) for the authorization code exchange.
- ID tokens are verified against the IdP's JWKS using the `iss`, `aud`, `exp`, and `nonce` claims.
- Discovery (`/.well-known/openid-configuration`) is fetched lazily and cached for 1 hour.
```

- [ ] **Step 3: Update sidebar**

Edit `docs/docs.json` — replace any `sso-google`, `sso-keycloak`, `sso-okta` references with a single `features/sso` entry.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: replace per-provider SSO docs with unified OIDC guide"
```

---

## Task 16: Update root example config and CHANGELOG

**Files:**
- Modify: `pgconsole.toml` (if present at repo root as example)
- Modify: `CHANGELOG.md` (if present)

- [ ] **Step 1: Check what config examples exist**

```bash
ls pgconsole*.toml 2>/dev/null
grep -l "type = \"google\"\|type = \"keycloak\"\|type = \"okta\"" -r . 2>/dev/null | grep -v node_modules
```

- [ ] **Step 2: Replace any example provider entries**

For each example file with old provider entries, replace with:

```toml
# [[auth.providers]]
# type = "oidc"
# name = "Your IdP"
# issuer_url = "https://auth.example.com"
# client_id = "pgconsole"
# client_secret = "..."
```

(Commented out — example only. Real configs differ per deployment.)

- [ ] **Step 3: Add CHANGELOG entry**

If `CHANGELOG.md` exists, prepend an entry under an "Unreleased" or new version section:

```md
### Breaking changes
- SSO provider configuration now uses generic OIDC. The `google`, `keycloak`, and `okta` provider types have been removed. Replace with `type = "oidc"` and `issuer_url`. See `docs/features/sso.mdx`.
- Plan-feature flags `SSO_GOOGLE`, `SSO_KEYCLOAK`, `SSO_OKTA` removed. OIDC SSO is available on all plans.

### Added
- Generic OIDC provider with discovery, PKCE, JWKS-based ID token verification, optional group claim mapping, and optional `default_policy` for JIT user provisioning.
```

- [ ] **Step 4: Commit**

```bash
git add pgconsole.toml CHANGELOG.md
git commit -m "chore: update example config and changelog for OIDC migration"
```

---

## Task 17: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: PASS. Note count of tests.

- [ ] **Step 2: Run the API integration tests**

Run: `pnpm test:api`
Expected: PASS. (These don't exercise SSO since `tests/pgconsole.test.toml` has no provider, but they verify auth doesn't regress.)

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: SUCCESS.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 5: Manual smoke test against a real OIDC IdP (recommended)**

Stand up a local Authelia or Keycloak (instructions in `docs/features/sso.mdx`). Configure pgconsole with the IdP. Sign in. Check:
- Sign-in button renders with correct label.
- Redirect to IdP works.
- Callback completes; you land on the dashboard.
- `/api/auth/session` returns `{ user.groups: [...] }` with expected ids.
- An unknown user is rejected when `default_policy` is unset; admitted when set.

- [ ] **Step 6: Final commit (if any cleanup)**

If verification surfaces anything, fix it. Otherwise, no commit needed.

---

## Self-review checklist (run after writing this plan)

- [x] Spec section "Configuration shape" → Task 6 covers all fields including validation.
- [x] Spec section "Architecture" → Tasks 1, 3, 8, 9 create the three new files; Task 8 deletes the old three.
- [x] Spec section "Components: OidcDiscovery" → Tasks 1–2.
- [x] Spec section "Components: JwksVerifier" → Tasks 3–4.
- [x] Spec section "Components: OIDC handler" → Tasks 9–12.
- [x] Spec section "Data flow: user resolution" → Task 10 implements; Task 11 covers the three branches.
- [x] Spec section "JWT payload extension" → Task 5 (auth.ts) + Task 8 (basic-auth groups) + Task 13 (IAM consumer).
- [x] Spec section "Error redirects" → Task 12 covers each documented code.
- [x] Spec section "Testing strategy" → Tests for each component live in their own test file matching the spec's three named test files.
- [x] Spec section "Migration / breaking changes" → Tasks 6 (validation rejects old types), 7 (drop features), 15 (docs), 16 (changelog).
- [x] Spec section "Non-goals: multiple OIDC providers" → Task 6 explicitly errors on second `oidc` entry.
- [x] No placeholders, no "implement later", every code step has the actual code.
- [x] Type names consistent: `getOidcProvider`, `verifyIdToken`, `getDiscovery`, `DiscoveryDocument`, `IdTokenError`, `DiscoveryError`, `DefaultPolicy`, `AuthProviderConfig`.
