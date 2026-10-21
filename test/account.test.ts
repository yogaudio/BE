import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/index";
import { signAccessToken } from "../src/tokens";
import { IDS, mockAccountUpstreams, type AccountUpstreamOpts } from "./helpers";

async function del(who: string | null = IDS.active, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (who) headers.Authorization = `Bearer ${await signAccessToken(env, who)}`;
  const ctx = createExecutionContext();
  const res = await route(new Request("https://api.test/account/delete", { method: "POST", headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const OTHER = "mem_other";
const count = async (table: string, id: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE member_id = ?`).bind(id).first<number>("n"))!;
async function seed(id: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO refresh_tokens (hash, member_id, expires_at) VALUES (?, ?, 9999999999)").bind(`rt_${id}`, id),
    env.DB.prepare("INSERT INTO auth_codes (hash, member_id, challenge, state, expires_at) VALUES (?, ?, 'c', 's', 9999999999)").bind(`ac_${id}`, id),
  ]);
  await env.CACHE.put(`ms:${id}`, JSON.stringify({ active: true, email: "x", at: Date.now() }));
}
const clean = async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM auth_codes"), env.DB.prepare("DELETE FROM refresh_tokens")]);
  for (const id of [...Object.values(IDS), OTHER]) await env.CACHE.delete(`ms:${id}`);
};
const deletes = (calls: string[]) => calls.filter((c) => c.startsWith("DELETE"));
const cleaned = async (id: string) => {
  expect([await count("refresh_tokens", id), await count("auth_codes", id)]).toEqual([0, 0]);
  expect(await env.CACHE.get<{ active: boolean }>(`ms:${id}`, "json")).toMatchObject({ active: false });
};
const kept = async (id: string) => expect([await count("refresh_tokens", id), await count("auth_codes", id), await env.CACHE.get(`ms:${id}`) !== null]).toEqual([1, 1, true]);

beforeEach(async () => {
  vi.restoreAllMocks();
  await clean();
  await seed(IDS.active);
  await seed(OTHER);
});

describe("POST /account/delete", () => {
  it("is off (404 not_found, no outbound fetch) while STRIPE_RESTRICTED_KEY is empty", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    const key = env.STRIPE_RESTRICTED_KEY;
    try {
      for (const off of ["", undefined as unknown as string]) {
        env.STRIPE_RESTRICTED_KEY = off;
        const res = await del(IDS.inactive); // a member with no Stripe customer
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    } finally {
      env.STRIPE_RESTRICTED_KEY = key;
    }
    expect(calls).toEqual([]);
  });

  it("active member: 204, ordered calls, local data gone, others untouched", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    const res = await del();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(calls).toEqual([
      `GET /memberstack/members/${IDS.active}`,
      "GET /stripe/v1/subscriptions",
      "DELETE /stripe/v1/subscriptions/sub_fake_active",
      `DELETE /memberstack/members/${IDS.active}`,
    ]);
    await cleaned(IDS.active);
    await kept(OTHER);
  });

  it("past-due member: both live subscriptions cancelled", async () => {
    await seed(IDS.pastDue);
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    expect((await del(IDS.pastDue)).status).toBe(204);
    expect(deletes(calls).filter((c) => c.includes("/stripe/"))).toHaveLength(2);
    await cleaned(IDS.pastDue);
  });

  it("inactive member (no Stripe customer): no Stripe calls, member deleted", async () => {
    await seed(IDS.inactive);
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    expect((await del(IDS.inactive)).status).toBe(204);
    expect(calls.some((c) => c.includes("/stripe/"))).toBe(false);
    expect(deletes(calls)).toEqual([`DELETE /memberstack/members/${IDS.inactive}`]);
    await cleaned(IDS.inactive);
  });

  it("member already gone: no Stripe or DELETE calls, local cleanup still runs", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls, memberGetStatus: 404 });
    expect((await del()).status).toBe(204);
    expect(calls).toEqual([`GET /memberstack/members/${IDS.active}`]);
    await cleaned(IDS.active);
  });

  it("Stripe list 500: 502 stripe_unavailable, nothing deleted anywhere", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls, stripeStatus: 500 });
    const res = await del();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "stripe_unavailable" });
    expect(calls.some((c) => c.startsWith("DELETE /memberstack"))).toBe(false);
    await kept(IDS.active);
  });

  it("Memberstack DELETE 500 after cancel: 502, rows kept; a retry is 204 with no Stripe DELETE", async () => {
    const calls: string[] = [];
    const opts: AccountUpstreamOpts = { calls, memberDeleteStatus: 500 };
    mockAccountUpstreams(opts);
    const res = await del();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
    expect(deletes(calls).filter((c) => c.includes("/stripe/"))).toHaveLength(1);
    await kept(IDS.active);

    opts.memberDeleteStatus = undefined;
    calls.length = 0;
    expect((await del()).status).toBe(204);
    expect(deletes(calls).filter((c) => c.includes("/stripe/"))).toHaveLength(0);
    expect(deletes(calls)).toEqual([`DELETE /memberstack/members/${IDS.active}`]);
    await cleaned(IDS.active);
  });

  it("Memberstack DELETE failure logs the status; success logs member id and count, never secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts: AccountUpstreamOpts = { memberDeleteStatus: 500 };
    mockAccountUpstreams(opts);
    expect((await del()).status).toBe(502);
    expect(warn.mock.calls.some((c) => c.includes(500))).toBe(true);
    opts.memberDeleteStatus = undefined;
    expect((await del()).status).toBe(204);
    expect(log).toHaveBeenCalledWith("account deleted:", IDS.active, "subscriptions cancelled:", 0);
    expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toMatch(/rk_fake_stripe|Bearer/);
  });

  it("401 without a token or with a bad one, no upstream calls", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    for (const res of [await del(null), await del(null, "garbage")]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    }
    expect(calls).toEqual([]);
    await kept(IDS.active);
  });

  it("after deletion the same access token gets 403 membership_inactive on /play", async () => {
    mockAccountUpstreams();
    const token = await signAccessToken(env, IDS.active);
    expect((await del(null, token)).status).toBe(204);
    const ctx = createExecutionContext();
    const res = await route(new Request("https://api.test/play/wf_good_1", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "membership_inactive" });
  });
});
