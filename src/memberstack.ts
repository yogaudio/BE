import type { Env } from "./env";
import { ApiError } from "./errors";
import { upstreamFetch } from "./upstream";

const FRESH_MS = 10 * 60_000;
export const STALE_MS = 24 * 3600_000;
const STALE_ACTIVE_MS = 3600_000; // a cached ACTIVE entry may unlock /play during an outage for 1h only; inactive keeps STALE_MS
const TIMEOUT_MS = 5000;

export interface Membership {
  active: boolean;
  stale: boolean;
  email: string;
}
type Cached = { active: boolean; email: string; at: number };

const headers = (env: Env) => ({ "x-api-key": env.MEMBERSTACK_SECRET_KEY, "content-type": "application/json" });
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

// Admin API: POST /members/verify-token -> { data: { id } }. A 4xx means the token is bad, except 401/403 (our secret key is wrong)
// and 429 (Memberstack throttling us): neither is the member's fault, so those are 502.
// verified 2026-10-23: response paths, proven by the live login.
export async function verifyMemberToken(env: Env, token: string): Promise<string> {
  const res = await upstreamFetch(
    `${env.MEMBERSTACK_API_BASE}/members/verify-token`,
    { method: "POST", headers: headers(env), body: JSON.stringify({ token }) },
    TIMEOUT_MS,
  );
  if (res.status >= 400) {
    // Status only, never the token: a wrong MEMBERSTACK_SECRET_KEY shows up here as a run of 401/403s.
    if ([401, 403, 429].includes(res.status)) {
      console.warn("memberstack verify-token: status", res.status);
      throw new ApiError(502, "upstream_unavailable");
    }
    throw new ApiError(401, "invalid_token");
  }
  const id = ((await res.json().catch(() => null)) as { data?: { id?: unknown } } | null)?.data?.id;
  if (typeof id !== "string" || !id) throw new ApiError(401, "invalid_token");
  return id;
}

// Admin API: GET /members/:id -> { data: { auth: { email }, planConnections: [{ planId, status }] } }.
// verified 2026-10-21 against real data
async function fetchMembership(env: Env, memberId: string): Promise<Cached> {
  const res = await upstreamFetch(`${env.MEMBERSTACK_API_BASE}/members/${encodeURIComponent(memberId)}`, { headers: headers(env) }, TIMEOUT_MS);
  if (!res.ok) throw new ApiError(502, "upstream_unavailable");
  const body = (await res.json().catch(() => undefined)) as { data?: any } | null | undefined;
  if (!body) throw new ApiError(502, "upstream_unavailable");
  const m = body.data;
  if (m === null) return { active: false, email: "", at: Date.now() }; // docs: a missing member is 200 with data null
  if (!m) throw new ApiError(502, "upstream_unavailable");
  // Status compare is case-insensitive; ACTIVE_PLAN_STATUSES is the allow-list, so any other status (PAST_DUE, CANCELED) does not unlock.
  const statuses = list(env.ACTIVE_PLAN_STATUSES).map((s) => s.toLowerCase());
  const plans = list(env.ALLOWED_PLAN_IDS);
  const active = ((m.planConnections ?? []) as { planId?: string; status?: string }[]).some(
    (c) => statuses.includes(String(c.status).toLowerCase()) && (plans.length === 0 || plans.includes(String(c.planId))),
  );
  return { active, email: String(m.auth?.email ?? ""), at: Date.now() };
}

// Admin API: GET /members/:id. A missing member is 200 with "data": null (never 404; a 404 is a wrong base URL, so it is an error).
// Resolves true if the member exists, false if already gone.
export async function memberExists(env: Env, memberId: string): Promise<boolean> {
  const res = await upstreamFetch(`${env.MEMBERSTACK_API_BASE}/members/${encodeURIComponent(memberId)}`, { headers: headers(env) }, TIMEOUT_MS);
  if (!res.ok) {
    console.warn("memberstack get member: status", res.status);
    throw new ApiError(502, "upstream_unavailable");
  }
  const body = (await res.json().catch(() => undefined)) as { data?: unknown } | null | undefined;
  if (!body || !("data" in body)) throw new ApiError(502, "upstream_unavailable");
  return body.data !== null;
}

// Admin API: DELETE /members/:id with a JSON body. Memberstack cancels the member's Stripe subscriptions and keeps the Stripe customer.
// Any non-2xx (a 400 "no member" included) is an error; callers check memberExists first.
export async function deleteMember(env: Env, memberId: string): Promise<void> {
  const res = await upstreamFetch(
    `${env.MEMBERSTACK_API_BASE}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE", headers: headers(env), body: JSON.stringify({ cancelStripeSubscriptions: true, deleteStripeCustomer: false }) },
    TIMEOUT_MS,
  );
  if (!res.ok) {
    console.warn("memberstack delete: status", res.status);
    throw new ApiError(502, "upstream_unavailable");
  }
}

export async function getMembership(env: Env, _ctx: ExecutionContext, memberId: string): Promise<Membership> {
  const k = `ms:${memberId}`;
  const cached = await env.CACHE.get<Cached>(k, "json").catch(() => null);
  const age = cached ? Date.now() - cached.at : Infinity;
  // Only a fresh ACTIVE entry skips Memberstack: an inactive one is always re-asked, so a renewal unlocks at once.
  if (cached?.active && age < FRESH_MS) return { active: cached.active, stale: false, email: cached.email };
  try {
    const fresh = await fetchMembership(env, memberId);
    await env.CACHE.put(k, JSON.stringify(fresh), { expirationTtl: STALE_MS / 1000 }).catch(() => {});
    return { active: fresh.active, stale: false, email: fresh.email };
  } catch (e) {
    if (cached && age < (cached.active ? STALE_ACTIVE_MS : STALE_MS)) {
      console.warn("membership: using stale cache for", memberId);
      return { active: cached.active, stale: true, email: cached.email };
    }
    throw e instanceof ApiError ? e : new ApiError(502, "upstream_unavailable");
  }
}
