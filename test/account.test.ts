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
  it("present member: 204, GET then DELETE, local data gone, others untouched", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    const res = await del();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(calls).toEqual([`GET /memberstack/members/${IDS.active}`, `DELETE /memberstack/members/${IDS.active}`]);
    await cleaned(IDS.active);
    await kept(OTHER);
  });

  it("DELETE carries both Stripe flags as JSON", async () => {
    const deleteRequests: { headers: Headers; body: unknown }[] = [];
    mockAccountUpstreams({ deleteRequests });
    expect((await del()).status).toBe(204);
    expect(deleteRequests).toHaveLength(1);
    expect(deleteRequests[0].body).toEqual({ cancelStripeSubscriptions: true, deleteStripeCustomer: false });
    expect(deleteRequests[0].headers.get("content-type")).toBe("application/json");
  });

  it("the member id comes from the token; a body or query naming another member is ignored", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    const headers = { Authorization: `Bearer ${await signAccessToken(env, IDS.active)}`, "Content-Type": "application/json" };
    const ctx = createExecutionContext();
    const res = await route(
      new Request(`https://api.test/account/delete?member_id=${OTHER}&id=${OTHER}`, { method: "POST", headers, body: JSON.stringify({ member_id: OTHER, id: OTHER }) }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(calls.every((c) => c.endsWith(IDS.active))).toBe(true);
    await cleaned(IDS.active);
    await kept(OTHER);
  });

  it("already gone (GET 200 data null): no DELETE, local cleanup runs, a second call is 204 too", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    await seed(IDS.noPlan);
    expect((await del(IDS.noPlan)).status).toBe(204); // deletes it
    await seed(IDS.noPlan); // leftover rows from a failed earlier cleanup
    calls.length = 0;
    expect((await del(IDS.noPlan)).status).toBe(204);
    expect(calls).toEqual([`GET /memberstack/members/${IDS.noPlan}`]);
    await cleaned(IDS.noPlan);
  });

  it("DELETE 400: 502 upstream_unavailable, rows and cache untouched", async () => {
    mockAccountUpstreams({ memberDeleteStatus: 400 });
    const res = await del();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
    await kept(IDS.active);
  });

  it("DELETE 500: 502, rows kept; a retry is 204", async () => {
    const opts: AccountUpstreamOpts = { memberDeleteStatus: 500 };
    mockAccountUpstreams(opts);
    expect((await del()).status).toBe(502);
    await kept(IDS.active);
    opts.memberDeleteStatus = undefined;
    expect((await del()).status).toBe(204);
    await cleaned(IDS.active);
  });

  it("GET 500, GET 404 or a network error: 502, no DELETE, nothing deleted", async () => {
    for (const opts of [{ memberGetStatus: 500 }, { memberGetStatus: 404 }, { memberDown: true }]) {
      vi.restoreAllMocks();
      const calls: string[] = [];
      mockAccountUpstreams({ calls, ...opts });
      const res = await del();
      expect(res.status, JSON.stringify(opts)).toBe(502);
      expect(await res.json()).toEqual({ error: "upstream_unavailable" });
      expect(deletes(calls)).toEqual([]);
      await kept(IDS.active);
    }
  });

  it("logs the failure status and the deleted id, never the secret key or Bearer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts: AccountUpstreamOpts = { memberDeleteStatus: 500 };
    mockAccountUpstreams(opts);
    expect((await del()).status).toBe(502);
    expect(warn.mock.calls.some((c) => c.includes(500))).toBe(true);
    opts.memberDeleteStatus = undefined;
    expect((await del()).status).toBe(204);
    expect(log).toHaveBeenCalledWith("account deleted:", IDS.active);
    expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toMatch(new RegExp(`${env.MEMBERSTACK_SECRET_KEY}|Bearer`));
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
