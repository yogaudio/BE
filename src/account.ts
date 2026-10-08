import type { Env } from "./env";
import { deleteMember, getStripeCustomerId } from "./memberstack";
import { cancelLiveSubscriptions } from "./stripe";
import { verifyAccessToken } from "./tokens";

// POST /account/delete. Order matters and every step is safe to repeat:
// Stripe first (a failure there deletes nothing), then the Memberstack member, then our own rows.
// A retry after a partial failure finds the subscriptions already cancelled or the member already gone.
export async function deleteAccount(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const id = await verifyAccessToken(env, request.headers.get("Authorization"));
  const customer = await getStripeCustomerId(env, id);
  if (customer !== "gone") {
    if (customer) await cancelLiveSubscriptions(env, customer);
    await deleteMember(env, id);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM refresh_tokens WHERE member_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_codes WHERE member_id = ?").bind(id),
  ]);
  // Drop the cached membership, or /play would keep trusting a fresh "active" entry for up to 10 minutes.
  await env.CACHE.delete(`ms:${id}`);
  return new Response(null, { status: 204 });
}
