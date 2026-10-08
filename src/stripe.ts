import type { Env } from "./env";
import { ApiError } from "./errors";
import { upstreamFetch } from "./upstream";

const TIMEOUT_MS = 5000;
const LIVE = ["active", "trialing", "past_due"];

// Any failure becomes stripe_unavailable (upstreamFetch's own 502 is re-mapped). Status only in logs, never the key.
async function stripeFetch(env: Env, path: string, method: "GET" | "DELETE"): Promise<Response> {
  let res: Response;
  try {
    res = await upstreamFetch(`${env.STRIPE_API_BASE}${path}`, { method, headers: { Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}` } }, TIMEOUT_MS);
  } catch {
    throw new ApiError(502, "stripe_unavailable");
  }
  if ([401, 403].includes(res.status)) console.warn("stripe: status", res.status);
  return res;
}

// Cancels every live subscription of the customer immediately: no proration or invoice params, so no refund.
// Returns how many were cancelled.
export async function cancelLiveSubscriptions(env: Env, customerId: string): Promise<number> {
  // verify in Task 10: list response for a deleted customer (assumed 404)
  const res = await stripeFetch(env, `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`, "GET");
  if (res.status === 404) return 0;
  if (!res.ok) throw new ApiError(502, "stripe_unavailable");
  const body = (await res.json().catch(() => null)) as { data?: { id?: string; status?: string }[] } | null;
  if (!body || !Array.isArray(body.data)) throw new ApiError(502, "stripe_unavailable");
  const live = body.data.filter((s) => typeof s.id === "string" && LIVE.includes(String(s.status)));
  for (const s of live) {
    const c = await stripeFetch(env, `/v1/subscriptions/${encodeURIComponent(s.id!)}`, "DELETE");
    if (!c.ok && c.status !== 404) throw new ApiError(502, "stripe_unavailable");
  }
  return live.length;
}
