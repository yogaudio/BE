# yogaudio-api

Cloudflare Worker behind the yogaudio reader app. It checks Memberstack membership, issues short-lived access tokens and rotating refresh tokens (D1), serves the Webflow class catalog (KV cache), resolves audio URLs only for active members, and deletes an account on request (`POST /account/delete`, M3: returns 404 until `STRIPE_RESTRICTED_KEY` is set; it cancels Stripe subscriptions, deletes the Memberstack member, then clears our tokens and cache; retry-safe). No framework; a plain router in `src/index.ts`.

## Local dev (with fakes)

```
cp .dev.vars.example .dev.vars   # fake secrets, git-ignored
npm install
npm run fakes                    # terminal 1: fake Memberstack/Stripe/Webflow + /app-login on :8788
npm run dev                      # terminal 2: applies local D1 migrations, runs wrangler dev on :8787
```

Try `curl localhost:8787/health` and open http://localhost:8788/app-login.

Fake auth: Memberstack `X-API-KEY`, Stripe `Authorization: Bearer rk_fake_stripe`, Webflow `Authorization: Bearer`; a wrong key gets 401. Fake member tokens: `fake-ms-token-active` (free ACTIVE), `fake-ms-token-noplan`, `fake-ms-token-canceled`, `fake-ms-token-requires-payment`. Fixtures live in `dev/fixtures/`.

Fault switches: `FAKE_FAULT=slow|500|drop npm run fakes`, `?fault=` on a request, or at runtime `curl 'localhost:8788/_fault?mode=500&service=webflow'` (`mode=off` clears; services: memberstack, stripe, webflow). The fakes keep state (deleted members, cancelled subscriptions) for the process; `curl localhost:8788/_reset` restores it.

## Config

Vars in `wrangler.toml` (no secrets): `LOGIN_PAGE_ORIGIN`, `ACTIVE_PLAN_STATUSES`, `ALLOWED_PLAN_IDS`, `MEMBERSTACK_API_BASE`, `WEBFLOW_API_BASE`, `STRIPE_API_BASE`, `WEBFLOW_COLLECTION_ID`, `WF_STYLES_COLLECTION_ID`, `WF_FOCUS_COLLECTION_ID`, `WF_DURATIONS_COLLECTION_ID`. Top-level vars target the fakes (local dev). `[env.production]` holds the real values: `https://www.yogaudio.com`, `https://admin.memberstack.com`, `https://api.webflow.com`. The production Webflow collection ids are real; the production D1/KV ids are real too (Cloudflare account `a41e300f…`); bindings and vars are not inherited between environments.

Secrets (`wrangler secret put <NAME>`; locally in `.dev.vars`): `MEMBERSTACK_SECRET_KEY`, `WEBFLOW_TOKEN`, `TOKEN_SIGNING_KEY` (all three set in production), and `STRIPE_RESTRICTED_KEY` (not set yet: `/account/delete` returns 404 until M3).

## Login page

`login-page/app-login.html` is the embed for yogaudio.com `/app-login`; steps for Elliott are in `login-page/README.md`. It is embed v4: it draws its own form and sets its own readable colours. The Worker URL it posts to is the single `window.YOGAUDIO_CODE_URL` line at the top of the embed, now `https://yogaudio-api.shrill-cloud-cf32.workers.dev/auth/code`. `LOGIN_PAGE_ORIGIN` in production is `https://www.yogaudio.com`. `npm run check:login` drives the local fake `/app-login` in headless Chrome.

## Production (done 2026-10-22)

Deployed to the client's Cloudflare account (`a41e300f…`) as worker `yogaudio-api`: D1 and KV created, migration applied remotely, secrets MEMBERSTACK_SECRET_KEY, WEBFLOW_TOKEN and TOKEN_SIGNING_KEY set. `ACTIVE_PLAN_STATUSES` is `ACTIVE,TRIALING` (`REQUIRES_PAYMENT` members get no access). The Memberstack verify-token and Webflow calls were proven by the live login and catalog (2026-10-23).

Still open for M3: `wrangler secret put STRIPE_RESTRICTED_KEY --env production` (restricted key: Customers read, Subscriptions write), then verify the Stripe and Memberstack delete paths marked "verify in M3" in `src/` (the Stripe customer field `stripeCustomerId` is already verified; a member with an unCANCELED paid plan and no customer id gets 502 and is not deleted). Sign in with Apple (App Review rule 4.8) is needed only if Google or another third-party login is ever added.

Redeploy: `wrangler deploy --env production`. To watch a first sign-in: `wrangler tail --env production`; a run of `memberstack verify-token: status 401/403` means `MEMBERSTACK_SECRET_KEY` is wrong, not the member's token.

## Rate limit, cleanup, observability

- `POST /auth/code` is limited to 10 requests per 60 s per client IP (`CF-Connecting-IP`) by the Workers Rate Limiting binding `AUTH_CODE_LIMITER` (namespace 1001). Over the limit: 429 `{"error":"rate_limited"}` (with CORS). If the binding is absent, or the limiter errors, there is no limit (fails open).
- A daily cron (`17 3 * * *`, UTC) deletes expired `auth_codes` and `refresh_tokens` rows (`cleanupExpired` in `src/auth.ts`). Revoked refresh tokens are kept until they expire, because reuse detection needs them. Migration `0002_expires_index.sql` indexes both `expires_at` columns.
- Production has Workers observability (logs) enabled; the cron logs `cleanup: codes N refresh M`.

### Deploy checklist (next deploy)

1. `wrangler d1 migrations apply DB --remote --env production` (run by the owner; adds the 0002 indexes).
2. `wrangler deploy --env production` (ships the rate limit binding, the cron trigger and observability).

## Tests

```
npm test            # vitest in the Workers pool
npm run typecheck   # tsc --noEmit, strict
npm run check:login # headless Chrome drives the fake /app-login
```

## Deploy

```
wrangler d1 migrations apply DB --remote --env production
wrangler deploy --env production
```

The secrets are set (three of the four; see Config) with `wrangler secret put <NAME> --env production`. A plain `wrangler deploy` would ship the local-dev (localhost) config, so always pass `--env production`. The top-level worker is named `yogaudio-api-dev`, so a plain deploy can never overwrite the production worker `yogaudio-api`. Every upstream call goes through `upstreamFetch` (`src/upstream.ts`), which turns timeouts, network errors and upstream 5xx into 502 `upstream_unavailable`.

`npm test` needs no `.dev.vars`: fake secrets and D1 migrations are set up in `vitest.config.ts`.
