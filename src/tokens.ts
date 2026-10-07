import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./env";
import { ApiError } from "./errors";

export const ACCESS_TTL_SEC = 15 * 60;
const enc = new TextEncoder();

export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// base64url(SHA-256(s)). Used for stored hashes of codes and refresh tokens, and for PKCE.
export const sha256 = async (s: string) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));

export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function pkceMatches(verifier: string, challenge: string) {
  return timingSafeEqual(await sha256(verifier), challenge);
}

const key = (env: Env) => enc.encode(env.TOKEN_SIGNING_KEY);

// Claims are sub, iat, exp only. `nowSec` is a seam for tests.
export const signAccessToken = (env: Env, memberId: string, nowSec = Math.floor(Date.now() / 1000)) =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(memberId).setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ACCESS_TTL_SEC).sign(key(env));

// Accepts the raw token or an "Authorization" header value ("Bearer <token>").
export async function verifyAccessToken(env: Env, bearer: string | null | undefined): Promise<string> {
  try {
    const token = (bearer ?? "").replace(/^Bearer /i, "");
    const { payload } = await jwtVerify(token, key(env), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no sub");
    return payload.sub;
  } catch {
    throw new ApiError(401, "invalid_token");
  }
}
