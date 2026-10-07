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

Vars in `wrangler.toml` (no secrets): `LOGIN_PAGE_ORIGIN`, `ACTIVE_PLAN_STATUSES`, `ALLOWED_PLAN_IDS`, `MEMBERSTACK_API_BASE`, `WEBFLOW_API_BASE`, `TRANSISTOR_API_BASE`, `WEBFLOW_COLLECTION_ID`. Top-level vars target the fakes (local dev). `[env.production]` holds the real values: `https://www.yogaudio.com`, `https://admin.memberstack.com`, `https://api.webflow.com`, `https://api.transistor.fm`. The production collection id and the production D1/KV ids are `SET_IN_TASK_10` placeholders; bindings and vars are not inherited between environments.

Secrets (`wrangler secret put <NAME>`; locally in `.dev.vars`): `MEMBERSTACK_SECRET_KEY`, `WEBFLOW_TOKEN`, `TRANSISTOR_API_KEY`, `TOKEN_SIGNING_KEY`.

## Login page

`login-page/app-login.html` is the embed for yogaudio.com `/app-login`; steps for Elliott are in `login-page/README.md`. The Worker URL it posts to is the single `window.YOGAUDIO_CODE_URL` line at the top of the embed (placeholder `https://API_HOST_SET_IN_TASK_10/auth/code`, set it in Task 10).

## Task 10 switch-over

Everything that is still a placeholder or an unchecked guess before the first production deploy.

Placeholders (`SET_IN_TASK_10`):
- `wrangler.toml:48` `WEBFLOW_COLLECTION_ID`: the Webflow classes collection id.
- `wrangler.toml:50` `WF_CATEGORY_COLLECTION_ID`: the category collection id (empty string = no categories).
- `wrangler.toml:62` production D1 `database_id`, `wrangler.toml:67` production KV `id` (see below).
- `login-page/app-login.html:8` `window.YOGAUDIO_CODE_URL`: the deployed Worker URL ending in `/auth/code`.

"Verify in Task 10" markers (check against the real APIs, fix the paths if they differ):
- `src/memberstack.ts:20` verify-token response (`data.id`); `src/memberstack.ts:38` member shape (`planConnections[].planId/status`, `auth.email`).
- `src/webflow.ts:33` Webflow v2 items response shape.
- `src/audio.ts:27` a share.transistor.fm URL's last segment works as an episode id; `src/audio.ts:37` Transistor episode response (`data.attributes.media_url`, `duration`).
- `wrangler.toml:49` the real Webflow field slugs: `WF_FIELD_TITLE`, `WF_FIELD_DURATION`, `WF_FIELD_CATEGORY`, `WF_FIELD_TEACHER`, `WF_FIELD_IMAGE`, `WF_FIELD_DESCRIPTION`, `WF_FIELD_AUDIO` (each names the CMS field the Worker reads for that value), plus `WF_CATEGORY_COLLECTION_ID`.
- `login-page/app-login.html:13` the Memberstack DOM calls (`$memberstackDom`, `getCurrentMember`, `onAuthChange`, `getMemberCookie`); `login-page/README.md:12` whether "redirect after login" can be turned off for one page.

Steps:
1. Create the stores and paste their ids into `[env.production]`:
   `./node_modules/.bin/wrangler d1 create yogaudio-api` and `./node_modules/.bin/wrangler kv namespace create CACHE`.
2. Apply the schema remotely: `./node_modules/.bin/wrangler d1 migrations apply DB --remote --env production`.
3. Secrets, each with `wrangler secret put <NAME> --env production`: `MEMBERSTACK_SECRET_KEY`, `WEBFLOW_TOKEN`, `TRANSISTOR_API_KEY`, and `TOKEN_SIGNING_KEY` generated fresh with `openssl rand -base64 48` (never reuse the local one; changing it later signs everyone out).
4. Membership rules: `ACTIVE_PLAN_STATUSES` (Q3, default `ACTIVE,TRIALING,PAST_DUE`) and `ALLOWED_PLAN_IDS` (Q4, default empty = any plan). Confirm both against the real plans before deploy.
5. Sign in with Apple (Q9): if the site offers Google or another third-party login, App Review rule 4.8 needs Sign in with Apple too. Recheck the live login form.
6. Deploy (`wrangler deploy --env production`), then set `YOGAUDIO_CODE_URL` in the Webflow embed.
7. Warm the catalog before members use the app. The first `/catalog` build looks up every class's episode on Transistor (4 at a time, then cached 24 h in `ep:` keys), and Transistor's rate limit can fail a cold build. Sign in once with a test member (or `GET /catalog` with its access token) and confirm classes come back. Putting direct `media.transistor.fm` URLs in the CMS audio field skips the lookups entirely.
8. Watch `wrangler tail --env production` during the first sign-in: a run of `memberstack verify-token: status 401/403` means `MEMBERSTACK_SECRET_KEY` is wrong, not the member's token.

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

Set the four secrets first with `wrangler secret put <NAME> --env production`. A plain `wrangler deploy` would ship the local-dev (localhost) config, so always pass `--env production`. The top-level worker is named `yogaudio-api-dev`, so a plain deploy can never overwrite the production worker `yogaudio-api`. Every upstream call goes through `upstreamFetch` (`src/upstream.ts`), which turns timeouts, network errors and upstream 5xx into 502 `upstream_unavailable`.

`npm test` needs no `.dev.vars`: fake secrets and D1 migrations are set up in `vitest.config.ts`.
