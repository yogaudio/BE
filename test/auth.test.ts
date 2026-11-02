import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/index";
import { IDS, mockMemberstack } from "./helpers";

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const post = (path: string, body: unknown) =>
  route(new Request(`http://api.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), env, createExecutionContext());

async function login(token = "fake-ms-token-active", extra: Record<string, unknown> = {}) {
  const r = await post("/auth/code", { memberstackToken: token, codeChallenge: challenge, state: "st", ...extra });
  return { r, code: ((await r.clone().json()) as { code?: string }).code! };
}
const exchange = (code: string, v = verifier) => post("/auth/exchange", { code, codeVerifier: v });
const err = async (r: Response) => ((await r.json()) as { error: string }).error;
async function signedIn(token?: string) {
  const { code } = await login(token);
  return (await (await exchange(code)).json()) as any;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([env.DB.prepare("DELETE FROM auth_codes"), env.DB.prepare("DELETE FROM refresh_tokens")]);
  for (const id of Object.values(IDS)) await env.CACHE.delete(`ms:${id}`);
  mockMemberstack();
});

describe("POST /auth/code", () => {
  it("returns a code for a valid Memberstack token and stores only its hash", async () => {
    const { r, code } = await login();
    expect(r.status).toBe(200);
    expect(code.length).toBeGreaterThanOrEqual(43);
    const rows = (await env.DB.prepare("SELECT * FROM auth_codes").all<any>()).results;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows[0]).toMatchObject({ member_id: IDS.active, challenge, state: "st" });
    expect(rows[0].expires_at - Date.now()).toBeGreaterThan(115_000);
    expect(rows[0].expires_at - Date.now()).toBeLessThanOrEqual(120_000);
  });

  it("400 on a malformed challenge or body, without calling Memberstack", async () => {
    const calls: string[] = [];
    mockMemberstack({ calls });
    for (const c of ["short", challenge + "A", "!".repeat(43), 5]) {
      const r = await post("/auth/code", { memberstackToken: "fake-ms-token-active", codeChallenge: c, state: "s" });
      expect([r.status, await err(r)]).toEqual([400, "invalid_request"]);
    }
    expect((await post("/auth/code", "not json")).status).toBe(400);
    expect((await post("/auth/code", { codeChallenge: challenge, state: "s" })).status).toBe(400);
    expect((await post("/auth/code", { memberstackToken: "t", codeChallenge: challenge })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("401 invalid_token for a bad Memberstack token", async () => {
    const { r } = await login("garbage");
    expect([r.status, await err(r)]).toEqual([401, "invalid_token"]);
  });

  it("502 when Memberstack is down", async () => {
    mockMemberstack({ down: true });
    const { r } = await login();
    expect([r.status, await err(r)]).toEqual([502, "upstream_unavailable"]);
  });
});

describe("POST /auth/exchange", () => {
  it("happy path returns tokens, member and active, storing only a refresh hash", async () => {
    const { code } = await login();
    const r = await exchange(code);
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b).toMatchObject({ accessTokenExpiresIn: 900, member: { id: IDS.active, email: "user-1@example.com" }, active: true });
    expect(b.accessToken.split(".")).toHaveLength(3);
    const rows = (await env.DB.prepare("SELECT * FROM refresh_tokens").all<any>()).results;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(b.refreshToken);
    expect(rows[0].member_id).toBe(IDS.active);
    const day = 86400_000;
    expect(rows[0].expires_at - Date.now()).toBeGreaterThan(59 * day);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM auth_codes").first("n")).toBe(0);
  });

  it("an inactive member still gets tokens with active:false", async () => {
    const b = await signedIn("fake-ms-token-canceled");
    expect(b.active).toBe(false);
    expect(b.accessToken).toBeTruthy();
  });

  it("code is single use", async () => {
    const { code } = await login();
    expect((await exchange(code)).status).toBe(200);
    const r = await exchange(code);
    expect([r.status, await err(r)]).toEqual([401, "invalid_grant"]);
  });

  it("an expired code fails (fake clock)", async () => {
    const { code } = await login();
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + 121_000);
    const r = await exchange(code);
    expect([r.status, await err(r)]).toEqual([401, "invalid_grant"]);
  });

  it("verifier mismatch fails and burns the code", async () => {
    const { code } = await login();
    const r = await exchange(code, "x".repeat(43));
    expect([r.status, await err(r)]).toEqual([401, "invalid_grant"]);
    expect((await exchange(code)).status).toBe(401);
  });

  it("unknown code is invalid_grant; bad body is 400", async () => {
    expect((await exchange("nope")).status).toBe(401);
    expect((await post("/auth/exchange", { code: "x" })).status).toBe(400);
    expect((await post("/auth/exchange", "{")).status).toBe(400);
  });

  it("502 when Memberstack is down and nothing is cached", async () => {
    const { code } = await login();
    await env.CACHE.delete(`ms:${IDS.active}`);
    mockMemberstack({ down: true });
    const r = await exchange(code);
    expect([r.status, await err(r)]).toEqual([502, "upstream_unavailable"]);
  });
});

describe("POST /auth/refresh", () => {
  it("rotates: new token works, old token is rejected afterwards", async () => {
    const first = await signedIn();
    const r = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect(r.status).toBe(200);
    const second = (await r.json()) as any;
    expect(second).toMatchObject({ member: { id: IDS.active, email: "user-1@example.com" }, active: true, accessTokenExpiresIn: 900 });
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const old = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect([old.status, await err(old)]).toEqual([401, "invalid_grant"]);
    const rows = (await env.DB.prepare("SELECT * FROM refresh_tokens").all<any>()).results;
    expect(JSON.stringify(rows)).not.toContain(second.refreshToken);
  });

  it("two concurrent refreshes with one token: exactly one wins", async () => {
    const { refreshToken } = await signedIn();
    const rs = await Promise.all([post("/auth/refresh", { refreshToken }), post("/auth/refresh", { refreshToken })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM refresh_tokens WHERE revoked_at IS NULL").first("n")).toBe(1);
  });

  it("unknown and expired tokens are invalid_grant", async () => {
    expect((await post("/auth/refresh", { refreshToken: "nope" })).status).toBe(401);
    const { refreshToken } = await signedIn();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 86400_000);
    const r = await post("/auth/refresh", { refreshToken });
    expect([r.status, await err(r)]).toEqual([401, "invalid_grant"]);
  });

  it("replaying a rotated token revokes all of that member's tokens, not other members'", async () => {
    const first = await signedIn();
    const other = await signedIn(); // second device of the same member
    const stranger = await signedIn("fake-ms-token-noplan");
    const second = (await (await post("/auth/refresh", { refreshToken: first.refreshToken })).json()) as any;
    const replay = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect([replay.status, await err(replay)]).toEqual([401, "invalid_grant"]);
    expect((await post("/auth/refresh", { refreshToken: second.refreshToken })).status).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: other.refreshToken })).status).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: stranger.refreshToken })).status).toBe(200);
  });

  it("400 on a missing token", async () => {
    expect((await post("/auth/refresh", {})).status).toBe(400);
  });

  it("re-checks membership: a lapsed member gets active:false", async () => {
    const first = await signedIn();
    await env.CACHE.delete(`ms:${IDS.active}`);
    mockMemberstack({ overrides: { planConnections: [{ planId: "pln_free-plan-6aap0jr6", status: "CANCELED" }] } });
    const b = (await (await post("/auth/refresh", { refreshToken: first.refreshToken })).json()) as any;
    expect(b.active).toBe(false);
  });

  it("stale membership fallback: Memberstack down, cache under 24h, member keeps the session", async () => {
    const first = await signedIn();
    await env.CACHE.put(`ms:${IDS.active}`, JSON.stringify({ active: true, email: "user-1@example.com", at: Date.now() - 3 * 3600_000 }));
    mockMemberstack({ down: true });
    const r = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ active: true, member: { email: "user-1@example.com" } });
  });

  it("502 and the token is not burned when Memberstack is down with no usable cache", async () => {
    const first = await signedIn();
    await env.CACHE.delete(`ms:${IDS.active}`);
    mockMemberstack({ down: true });
    const r = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect([r.status, await err(r)]).toEqual([502, "upstream_unavailable"]);
    mockMemberstack();
    expect((await post("/auth/refresh", { refreshToken: first.refreshToken })).status).toBe(200);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the token; refresh then fails; idempotent; unknown is 204", async () => {
    const { refreshToken } = await signedIn();
    expect((await post("/auth/logout", { refreshToken })).status).toBe(204);
    expect((await post("/auth/logout", { refreshToken })).status).toBe(204);
    expect((await post("/auth/logout", { refreshToken: "never-issued" })).status).toBe(204);
    const r = await post("/auth/refresh", { refreshToken });
    expect([r.status, await err(r)]).toEqual([401, "invalid_grant"]);
  });

  it("replaying a logged-out token revokes the member's other tokens", async () => {
    const a = await signedIn();
    const b = await signedIn();
    await post("/auth/logout", { refreshToken: a.refreshToken });
    expect((await post("/auth/refresh", { refreshToken: a.refreshToken })).status).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: b.refreshToken })).status).toBe(401);
  });

  it("400 on a missing token", async () => {
    expect((await post("/auth/logout", {})).status).toBe(400);
  });
});
