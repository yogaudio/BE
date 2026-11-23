# yogaudio-api: overview

Cloudflare Worker (TypeScript, no framework) behind the yogaudio reader app. Checks Memberstack membership, issues tokens, serves the Webflow class catalog, and hands out audio URLs to active members only.

Setup, config and deploy: see [README](../README.md).

## System

```mermaid
flowchart LR
  Login[Login page<br/>yogaudio.com/app-login] -->|POST /auth/code| W
  App[Reader app] -->|HTTPS + Bearer token| W
  subgraph W[Worker]
    R[Router<br/>src/index.ts]
  end
  W <--> D1[(D1<br/>auth_codes<br/>refresh_tokens)]
  W <--> KV[(KV<br/>catalog cache)]
  W --> MS[Memberstack<br/>membership]
  W --> WF[Webflow<br/>classes]
  Cron[Daily cron 03:17 UTC] --> W
```

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness |
| `POST /auth/code` | Memberstack token | one-time code (rate limited, CORS) |
| `POST /auth/exchange` | code + PKCE verifier | access + refresh tokens |
| `POST /auth/refresh` | refresh token | rotate tokens |
| `POST /auth/logout` | refresh token | revoke token |
| `POST /account/delete` | access token | delete member in Memberstack, clear local data |
| `GET /catalog` | access token | class list (ETag) |
| `GET /play/:classId` | access token + active plan | audio URL |

## Sign-in (PKCE)

```mermaid
sequenceDiagram
  participant L as Login page
  participant A as App
  participant W as Worker
  participant M as Memberstack
  L->>W: /auth/code (memberstackToken, codeChallenge)
  W->>M: verify token
  W-->>L: code (120 s, single use)
  L->>A: code
  A->>W: /auth/exchange (code, codeVerifier)
  W->>M: membership active?
  W-->>A: access token (15 min) + refresh token (60 d)
  A->>W: /auth/refresh (rotates refresh token)
```

Reusing a rotated or revoked refresh token revokes all of that member's tokens.

## Catalog and play

```mermaid
flowchart TD
  C[GET /catalog] --> V{valid access token?}
  V -- no --> E401[401]
  V -- yes --> K{KV entry?}
  K -- none --> B[Rebuild from Webflow]
  K -- "older than 60 s" --> L{rebuild lock?}
  L -- held --> S[Serve cached]
  L -- free --> B
  K -- fresh --> S
  B -- fails --> S
  B --> S

  P[GET /play/:classId] --> V2{token + active plan?}
  V2 -- no --> E403[401 / 403]
  V2 -- yes --> I{id in cached audio index?}
  I -- yes --> U[Return url]
  I -- "no, cache not just built" --> RB[One inline rebuild] --> I2{found?}
  I2 -- yes --> U
  I2 -- no --> N[404]
```

## Source map

| File | Role |
|---|---|
| `src/index.ts` | router, CORS, cron entry |
| `src/auth.ts` | code, exchange, refresh, logout, cleanup |
| `src/tokens.ts` | access JWT, PKCE, hashing |
| `src/memberstack.ts` | verify token, membership check |
| `src/catalog.ts` / `src/webflow.ts` | Webflow fetch, normalize, KV cache |
| `src/audio.ts` | `/play` |
| `src/account.ts` | account deletion |
| `src/upstream.ts` | upstream calls; timeouts and 5xx become 502 |
| `dev/` | fake Memberstack/Webflow servers for local dev |

## Known limit

`/play` returns a public Transistor URL (`expiresAt: null`). The membership check gates who gets it; the URL itself does not expire.
