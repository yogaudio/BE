import type { Env } from "./env";
import { ApiError } from "./errors";
import { deleteMember, getStripeCustomerId, STALE_MS } from "./memberstack";
import { cancelLiveSubscriptions } from "./stripe";
import { verifyAccessToken } from "./tokens";

// POST /account/delete. Order matters and every step is safe to repeat:
// Stripe first (a failure there deletes nothing), then the Memberstack member, then our own rows.
// A retry after a partial failure finds the subscriptions already cancelled or the member already gone.
export async function deleteAccount(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  // Safety: without the Stripe key a member with no Stripe customer would still be deleted from Memberstack. Off until configured.
  if (!env.STRIPE_RESTRICTED_KEY) throw new ApiError(404, "not_found");
  const id = await verifyAccessToken(env, request.headers.get("Authorization"));
  const customer = await getStripeCustomerId(env, id);
  let cancelled = 0;
  if (customer !== "gone") {
    if (customer) cancelled = await cancelLiveSubscriptions(env, customer);
    await deleteMember(env, id);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM refresh_tokens WHERE member_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_codes WHERE member_id = ?").bind(id),
  ]);
  // Overwrite (not delete) the cached membership with an inactive entry: an in-flight request cannot then re-cache a fresh "active" one
  // for /play to trust. Same shape and TTL as getMembership writes.
  await env.CACHE.put(`ms:${id}`, JSON.stringify({ active: false, email: "", at: Date.now() }), { expirationTtl: STALE_MS / 1000 });
  console.log("account deleted:", id, "subscriptions cancelled:", cancelled);
  return new Response(null, { status: 204 });
}
