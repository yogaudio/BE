import type { Env } from "./env";
import { ApiError } from "./errors";
import { getMembership, verifyMemberToken } from "./memberstack";
import { ACCESS_TTL_SEC, pkceMatches, randomToken, sha256, signAccessToken } from "./tokens";

const CODE_TTL_MS = 120_000;
const REFRESH_TTL_MS = 60 * 86400_000;

async function body(request: Request, ...fields: string[]): Promise<Record<string, string>> {
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new ApiError(400, "invalid_request");
  for (const f of fields) if (typeof b[f] !== "string" || !b[f]) throw new ApiError(400, "invalid_request");
  return b as Record<string, string>;
}

const grantError = () => new ApiError(401, "invalid_grant");

export async function authCode(request: Request, env: Env): Promise<Response> {
  const b = await body(request, "memberstackToken", "codeChallenge", "state");
  if (!/^[A-Za-z0-9_-]{43}$/.test(b.codeChallenge)) throw new ApiError(400, "invalid_request");
  const memberId = await verifyMemberToken(env, b.memberstackToken);
  const code = randomToken();
  await env.DB.prepare("INSERT INTO auth_codes (hash, member_id, challenge, state, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(code), memberId, b.codeChallenge, b.state, Date.now() + CODE_TTL_MS).run();
  return Response.json({ code });
}

async function respond(env: Env, memberId: string, refreshToken: string, m: { active: boolean; email: string }) {
  return Response.json({
    accessToken: await signAccessToken(env, memberId),
    accessTokenExpiresIn: ACCESS_TTL_SEC,
    refreshToken,
    member: { id: memberId, email: m.email },
    active: m.active,
  });
}

export async function authExchange(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const b = await body(request, "code", "codeVerifier");
  // One statement deletes and returns the row, so a code can be consumed exactly once.
  const row = await env.DB.prepare("DELETE FROM auth_codes WHERE hash = ? RETURNING member_id, challenge, expires_at")
    .bind(await sha256(b.code)).first<{ member_id: string; challenge: string; expires_at: number }>();
  if (!row || row.expires_at <= Date.now() || !(await pkceMatches(b.codeVerifier, row.challenge))) throw grantError();
  const m = await getMembership(env, ctx, row.member_id);
  const refreshToken = randomToken();
  await env.DB.prepare("INSERT INTO refresh_tokens (hash, member_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(refreshToken), row.member_id, Date.now() + REFRESH_TTL_MS).run();
  return respond(env, row.member_id, refreshToken, m);
}

export async function authRefresh(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const b = await body(request, "refreshToken");
  const oldHash = await sha256(b.refreshToken);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT member_id FROM refresh_tokens WHERE hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(oldHash, now).first<{ member_id: string }>();
  if (!row) throw grantError();
  // Before rotating, so an upstream failure doesn't burn the member's token.
  const m = await getMembership(env, ctx, row.member_id);
  const refreshToken = randomToken();
  // Atomic: revoke the old token and insert its replacement, or neither. changes() is the revoke's
  // row count, so a concurrent refresh that lost the race inserts nothing.
  const [revoked, inserted] = await env.DB.batch([
    env.DB.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL AND expires_at > ?").bind(now, oldHash, now),
    env.DB.prepare("INSERT INTO refresh_tokens (hash, member_id, expires_at) SELECT ?, ?, ? WHERE changes() = 1")
      .bind(await sha256(refreshToken), row.member_id, now + REFRESH_TTL_MS),
  ]);
  if (revoked.meta.changes !== 1 || inserted.meta.changes !== 1) throw grantError();
  return respond(env, row.member_id, refreshToken, m);
}

export async function authLogout(request: Request, env: Env): Promise<Response> {
  const b = await body(request, "refreshToken");
  await env.DB.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), await sha256(b.refreshToken)).run();
  return new Response(null, { status: 204 });
}
