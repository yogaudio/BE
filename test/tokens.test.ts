import { env } from "cloudflare:test";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { pkceMatches, sha256, signAccessToken, verifyAccessToken } from "../src/tokens";

const bad = (e: unknown) => (e as { status: number; code: string }).status === 401 && (e as { code: string }).code === "invalid_token";

describe("access tokens", () => {
  it("round trips and carries only sub, iat, exp", async () => {
    const t = await signAccessToken(env, "mem_1");
    expect(await verifyAccessToken(env, t)).toBe("mem_1");
    expect(await verifyAccessToken(env, `Bearer ${t}`)).toBe("mem_1");
    const claims = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(Object.keys(claims).sort()).toEqual(["exp", "iat", "sub"]);
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("expired token fails", async () => {
    const t = await signAccessToken(env, "mem_1", Math.floor(Date.now() / 1000) - 1000);
    await expect(verifyAccessToken(env, t)).rejects.toSatisfy(bad);
  });

  it("tampered, wrong-key and garbage tokens fail", async () => {
    const t = await signAccessToken(env, "mem_1");
    const [h, p, s] = t.split(".");
    const forged = btoa(JSON.stringify({ sub: "mem_2", iat: 1, exp: 9999999999 })).replace(/=/g, "");
    await expect(verifyAccessToken(env, `${h}.${forged}.${s}`)).rejects.toSatisfy(bad);
    const other = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("mem_1").setExpirationTime("5m")
      .sign(new TextEncoder().encode("another-key-another-key-another-key-0"));
    await expect(verifyAccessToken(env, other)).rejects.toSatisfy(bad);
    await expect(verifyAccessToken(env, "nope")).rejects.toSatisfy(bad);
    await expect(verifyAccessToken(env, p)).rejects.toSatisfy(bad);
  });
});

describe("PKCE", () => {
  // RFC 7636 appendix B
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  it("accepts the RFC test vector and rejects others", async () => {
    expect(await pkceMatches(verifier, challenge)).toBe(true);
    expect(await pkceMatches(verifier + "x", challenge)).toBe(false);
    expect(await pkceMatches(verifier, challenge.slice(0, 42) + "A")).toBe(false);
    expect(await pkceMatches(verifier, "short")).toBe(false);
  });
  it("sha256 is stable base64url", async () => {
    expect(await sha256("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});
