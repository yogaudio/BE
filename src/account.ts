import type { Env } from "./env";
import { deleteMember, memberExists, STALE_MS } from "./memberstack";
import { verifyAccessToken } from "./tokens";

// POST /account/delete. Every step is safe to repeat: a retry after a partial failure (member deleted, D1 failed) finds the member gone and
// finishes the cleanup. The member id comes only from the access token. Memberstack cancels the Stripe subscriptions itself.
export async function deleteAccount(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const id = await verifyAccessToken(env, request.headers.get("Authorization"));
  if (await memberExists(env, id)) await deleteMember(env, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM refresh_tokens WHERE member_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_codes WHERE member_id = ?").bind(id),
  ]);
  // Overwrite (not delete) the cached membership with an inactive entry: an in-flight request cannot then re-cache a fresh "active" one
  // for /play to trust. Same shape and TTL as getMembership writes.
  await env.CACHE.put(`ms:${id}`, JSON.stringify({ active: false, email: "", at: Date.now() }), { expirationTtl: STALE_MS / 1000 });
  console.log("account deleted:", id);
  return new Response(null, { status: 204 });
}
