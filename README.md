# yogaudio-api

Cloudflare Worker behind the yogaudio reader app. It checks Memberstack membership, issues short-lived access tokens and rotating refresh tokens (D1), serves the Webflow class catalog (KV cache), resolves audio URLs only for active members, and deletes an account on request (`POST /account/delete`: cancels Stripe subscriptions, deletes the Memberstack member, then clears our tokens and cache; retry-safe). No framework; a plain router in `src/index.ts`.

## Local dev (with fakes)

```
cp .dev.vars.example .dev.vars   # fake secrets, git-ignored
npm install
npm run fakes                    # terminal 1: fake Memberstack/Stripe/Webflow + /app-login on :8788
npm run dev                      # terminal 2: applies local D1 migrations, runs wrangler dev on :8787
```

Try `curl localhost:8787/health` and open http://localhost:8788/app-login.

Fake auth: Memberstack `X-API-KEY`, Stripe `Authorization: Bearer rk_fake_stripe`, Webflow `Authorization: Bearer`; a wrong key gets 401. Fake member tokens: `fake-ms-token-active`, `fake-ms-token-inactive`, `fake-ms-token-pastdue`. Fixtures live in `dev/fixtures/`.

Fault switches: `FAKE_FAULT=slow|500|drop npm run fakes`, `?fault=` on a request, or at runtime `curl 'localhost:8788/_fault?mode=500&service=webflow'` (`mode=off` clears; services: memberstack, stripe, webflow). The fakes keep state (deleted members, cancelled subscriptions) for the process; `curl localhost:8788/_reset` restores it.

## Config

Vars in `wrangler.toml` (no secrets): `LOGIN_PAGE_ORIGIN`, `ACTIVE_PLAN_STATUSES`, `ALLOWED_PLAN_IDS`, `MEMBERSTACK_API_BASE`, `WEBFLOW_API_BASE`, `STRIPE_API_BASE`, `WEBFLOW_COLLECTION_ID`. Top-level vars target the fakes (local dev). `[env.production]` holds the real values: `https://www.yogaudio.com`, `https://admin.memberstack.com`, `https://api.webflow.com`. The production collection id and the production D1/KV ids are `SET_IN_TASK_10` placeholders; bindings and vars are not inherited between environments.

Secrets (`wrangler secret put <NAME>`; locally in `.dev.vars`): `MEMBERSTACK_SECRET_KEY`, `WEBFLOW_TOKEN`, `STRIPE_RESTRICTED_KEY`, `TOKEN_SIGNING_KEY`.

## Login page

`login-page/app-login.html` is the embed for yogaudio.com `/app-login`; steps for Elliott are in `login-page/README.md`. The Worker URL it posts to is the single `window.YOGAUDIO_CODE_URL` line at the top of the embed (placeholder `https://API_HOST_SET_IN_TASK_10/auth/code`, set it in Task 10).

## Task 10 switch-over

Everything that is still a placeholder or an unchecked guess before the first production deploy.

Placeholders (`SET_IN_TASK_10`):
- `wrangler.toml:51` `WEBFLOW_COLLECTION_ID`: the Webflow classes collection id.
- `wrangler.toml:53` `WF_CATEGORY_COLLECTION_ID`: the category collection id (empty string = no categories).
- `wrangler.toml:65` production D1 `database_id`, `wrangler.toml:70` production KV `id` (see below).
- `login-page/app-login.html:8` `window.YOGAUDIO_CODE_URL`: the deployed Worker URL ending in `/auth/code`.

"Verify in Task 10" markers (check against the real APIs, fix the paths if they differ):
- `src/memberstack.ts:20` verify-token response (`data.id`); `src/memberstack.ts:38` member shape (`planConnections[].planId/status`, `auth.email`).
- `src/memberstack.ts:54` `getStripeCustomerId` member field name `stripeCustomerId`; `src/memberstack.ts:65` `deleteMember` delete endpoint and whether it cancels Stripe itself.
- `src/stripe.ts:23` subscription list response for a deleted customer (assumed 404; a 400 with `error.code` `resource_missing` is also treated as "customer gone"). `STRIPE_RESTRICTED_KEY` (Customers read, Subscriptions write) and `STRIPE_API_BASE` (`wrangler.toml:49`, already `https://api.stripe.com`) are listed in the steps below.
- `src/webflow.ts:33` Webflow v2 items response shape.
- `wrangler.toml:52` the real Webflow field slugs: `WF_FIELD_TITLE`, `WF_FIELD_DURATION`, `WF_FIELD_CATEGORY`, `WF_FIELD_TEACHER`, `WF_FIELD_IMAGE`, `WF_FIELD_DESCRIPTION` (each names the CMS field the Worker reads for that value), plus `WF_CATEGORY_COLLECTION_ID`.
- `login-page/app-login.html:13` the Memberstack DOM calls (`$memberstackDom`, `getCurrentMember`, `onAuthChange`, `getMemberCookie`); `login-page/README.md:12` whether "redirect after login" can be turned off for one page.

Steps:
1. Create the stores and paste their ids into `[env.production]`:
   `./node_modules/.bin/wrangler d1 create yogaudio-api` and `./node_modules/.bin/wrangler kv namespace create CACHE`.
2. Apply the schema remotely: `./node_modules/.bin/wrangler d1 migrations apply DB --remote --env production`.
3. Secrets, each with `wrangler secret put <NAME> --env production`: `MEMBERSTACK_SECRET_KEY`, `WEBFLOW_TOKEN`, `STRIPE_RESTRICTED_KEY` (restricted key: Customers read, Subscriptions write), and `TOKEN_SIGNING_KEY` generated fresh with `openssl rand -base64 48` (never reuse the local one; changing it later signs everyone out).
4. Membership rules: `ACTIVE_PLAN_STATUSES` (Q3, default `ACTIVE,TRIALING`) and `ALLOWED_PLAN_IDS` (Q4, default empty = any plan). Confirm both against the real plans before deploy.
5. Sign in with Apple (Q9): if the site offers Google or another third-party login, App Review rule 4.8 needs Sign in with Apple too. Recheck the live login form.
6. Deploy (`wrangler deploy --env production`), then set `YOGAUDIO_CODE_URL` in the Webflow embed.
7. Watch `wrangler tail --env production` during the first sign-in: a run of `memberstack verify-token: status 401/403` means `MEMBERSTACK_SECRET_KEY` is wrong, not the member's token.

## Tests

```
npm test            # vitest in the Workers pool
npm run typecheck   # tsc --noEmit, strict
```

## Deploy

```
wrangler d1 migrations apply DB --remote --env production
wrangler deploy --env production
```

Set the five secrets first with `wrangler secret put <NAME> --env production`. A plain `wrangler deploy` would ship the local-dev (localhost) config, so always pass `--env production`. The top-level worker is named `yogaudio-api-dev`, so a plain deploy can never overwrite the production worker `yogaudio-api`. Every upstream call goes through `upstreamFetch` (`src/upstream.ts`), which turns timeouts, network errors and upstream 5xx into 502 `upstream_unavailable`.

`npm test` needs no `.dev.vars`: fake secrets and D1 migrations are set up in `vitest.config.ts`.
