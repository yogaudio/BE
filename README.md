# yogaudio-api

Cloudflare Worker behind the yogaudio reader app. It checks Memberstack membership, issues short-lived access tokens and rotating refresh tokens (D1), serves the Webflow class catalog (KV cache) and resolves audio URLs only for active members. No framework; a plain router in `src/index.ts`.

## Local dev (with fakes)

```
cp .dev.vars.example .dev.vars   # fake secrets, git-ignored
npm install
npm run fakes                    # terminal 1: fake Memberstack/Webflow/Transistor + /app-login on :8788
npm run dev                      # terminal 2: applies local D1 migrations, runs wrangler dev on :8787
```

Try `curl localhost:8787/health` and open http://localhost:8788/app-login.

Fake auth: Memberstack `X-API-KEY`, Webflow `Authorization: Bearer`, Transistor `x-api-key`; a wrong key gets 401. Fake member tokens: `fake-ms-token-active`, `fake-ms-token-inactive`, `fake-ms-token-pastdue`. Fixtures live in `dev/fixtures/`.

Fault switches: `FAKE_FAULT=slow|500|drop npm run fakes`, `?fault=` on a request, or at runtime `curl 'localhost:8788/_fault?mode=500&service=webflow'` (`mode=off` clears).

## Config

Vars in `wrangler.toml` (no secrets): `LOGIN_PAGE_ORIGIN`, `ACTIVE_PLAN_STATUSES`, `ALLOWED_PLAN_IDS`, `MEMBERSTACK_API_BASE`, `WEBFLOW_API_BASE`, `TRANSISTOR_API_BASE`, `WEBFLOW_COLLECTION_ID`. Committed values target the fakes. Production: `https://www.yogaudio.com`, `https://admin.memberstack.com`, `https://api.webflow.com`, `https://api.transistor.fm`, and the real collection id. The D1 and KV ids in `wrangler.toml` are placeholders.

Secrets (`wrangler secret put <NAME>`; locally in `.dev.vars`): `MEMBERSTACK_SECRET_KEY`, `WEBFLOW_TOKEN`, `TRANSISTOR_API_KEY`, `TOKEN_SIGNING_KEY`.

## Tests

```
npm test            # vitest in the Workers pool
npm run typecheck   # tsc --noEmit, strict
```
