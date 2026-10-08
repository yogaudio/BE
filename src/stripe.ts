import type { Env } from "./env";
import { ApiError } from "./errors";
import { upstreamFetch } from "./upstream";

const TIMEOUT_MS = 5000;
// Stripe lists non-canceled subscriptions by default; every one of them except incomplete_expired (never charged, cannot revive) must be cancelled.
const DONE = ["canceled", "incomplete_expired"];

// Any failure becomes stripe_unavailable (upstreamFetch's own 502 is re-mapped). Status only in logs, never the key.
async function stripeFetch(env: Env, path: string, method: "GET" | "DELETE"): Promise<Response> {
  let res: Response;
  try {
    res = await upstreamFetch(`${env.STRIPE_API_BASE}${path}`, { method, headers: { Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}` } }, TIMEOUT_MS);
  } catch {
    throw new ApiError(502, "stripe_unavailable");
  }
  if (!res.ok) console.warn("stripe: status", res.status);
  return res;
}

// Cancels every subscription that is not canceled or incomplete_expired of the customer immediately: no proration or invoice params, so no refund.
// Returns how many were cancelled.
export async function cancelLiveSubscriptions(env: Env, customerId: string): Promise<number> {
  // verify in Task 10: list response for a deleted customer (assumed 404, or 400 with error.code resource_missing)
  const res = await stripeFetch(env, `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&limit=100`, "GET");
  if (res.status === 404) return 0;
  if (res.status === 400 && ((await res.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code === "resource_missing") return 0;
  if (!res.ok) throw new ApiError(502, "stripe_unavailable");
  const body = (await res.json().catch(() => null)) as { data?: { id?: string; status?: string }[]; has_more?: boolean } | null;
  if (!body || !Array.isArray(body.data)) throw new ApiError(502, "stripe_unavailable");
  // ponytail: one page of 100 subscriptions; fail closed rather than delete a member with a live sub unseen. Add paging (starting_after) if a customer ever has >100.
  if (body.has_more) throw new ApiError(502, "stripe_unavailable");
  const live = body.data.filter((s) => typeof s.id === "string" && !DONE.includes(String(s.status)));
  for (const s of live) {
    const c = await stripeFetch(env, `/v1/subscriptions/${encodeURIComponent(s.id!)}`, "DELETE");
    if (!c.ok && c.status !== 404) throw new ApiError(502, "stripe_unavailable");
  }
  return live.length;
}
