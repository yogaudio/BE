import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMembership, verifyMemberToken } from "../src/memberstack";
import { IDS, mockMemberstack } from "./helpers";

const ctx = () => createExecutionContext();
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const id of Object.values(IDS)) await env.CACHE.delete(`ms:${id}`);
});

describe("getMembership", () => {
  it("active, inactive and past-due fixtures", async () => {
    mockMemberstack();
    expect(await getMembership(env, ctx(), IDS.active)).toMatchObject({ active: true, stale: false, email: "active@example.test" });
    expect(await getMembership(env, ctx(), IDS.inactive)).toMatchObject({ active: false, stale: false });
    expect(await getMembership(env, ctx(), IDS.pastDue)).toMatchObject({ active: true, stale: false });
  });

  it("ALLOWED_PLAN_IDS restricts the plan", async () => {
    mockMemberstack();
    expect((await getMembership({ ...env, ALLOWED_PLAN_IDS: "pln_other" }, ctx(), IDS.active)).active).toBe(false);
    await env.CACHE.delete(`ms:${IDS.active}`);
    expect((await getMembership({ ...env, ALLOWED_PLAN_IDS: "pln_x, pln_fake_monthly" }, ctx(), IDS.active)).active).toBe(true);
  });

  it("a fresh cache entry makes no fetch", async () => {
    const calls: string[] = [];
    mockMemberstack({ calls });
    await getMembership(env, ctx(), IDS.active);
    expect(calls).toHaveLength(1);
    await getMembership(env, ctx(), IDS.active);
    expect(calls).toHaveLength(1);
  });

  it("a deleted member (404) is inactive, and an inactive entry is always re-asked", async () => {
    const calls: string[] = [];
    mockMemberstack({ calls });
    expect(await getMembership(env, ctx(), "mem_deleted")).toEqual({ active: false, stale: false, email: "" });
    await getMembership(env, ctx(), "mem_deleted");
    expect(calls).toHaveLength(2);
    await env.CACHE.delete("ms:mem_deleted");
  });

  describe("stale membership fallback", () => {
    const seed = (ageMs: number) =>
      env.CACHE.put(`ms:${IDS.active}`, JSON.stringify({ active: true, email: "active@example.test", at: Date.now() - ageMs }));

    it("uses a cached entry under 24h old when Memberstack is down, marked stale", async () => {
      await seed(2 * 3600_000);
      mockMemberstack({ down: true });
      expect(await getMembership(env, ctx(), IDS.active)).toEqual({ active: true, stale: true, email: "active@example.test" });
    });

    it("throws upstream_unavailable over 24h old or with no cache", async () => {
      mockMemberstack({ down: true });
      await seed(25 * 3600_000);
      await expect(getMembership(env, ctx(), IDS.active)).rejects.toMatchObject({ status: 502, code: "upstream_unavailable" });
      await env.CACHE.delete(`ms:${IDS.active}`);
      await expect(getMembership(env, ctx(), IDS.active)).rejects.toMatchObject({ status: 502, code: "upstream_unavailable" });
    });

    it("a fresh inactive entry is rechecked, so a renewal unlocks at once", async () => {
      await env.CACHE.put(`ms:${IDS.active}`, JSON.stringify({ active: false, email: "active@example.test", at: Date.now() - 60_000 }));
      const calls: string[] = [];
      mockMemberstack({ calls });
      expect(await getMembership(env, ctx(), IDS.active)).toEqual({ active: true, stale: false, email: "active@example.test" });
      expect(calls).toHaveLength(1);
    });

    it("a fresh inactive entry is the stale fallback when Memberstack is down", async () => {
      await env.CACHE.put(`ms:${IDS.inactive}`, JSON.stringify({ active: false, email: "x@example.test", at: Date.now() - 60_000 }));
      mockMemberstack({ down: true });
      expect(await getMembership(env, ctx(), IDS.inactive)).toEqual({ active: false, stale: true, email: "x@example.test" });
    });

    it("refetches when the entry is older than 10 min and Memberstack is up", async () => {
      await seed(11 * 60_000);
      const calls: string[] = [];
      mockMemberstack({ calls });
      expect((await getMembership(env, ctx(), IDS.active)).stale).toBe(false);
      expect(calls).toHaveLength(1);
    });
  });
});

describe("verifyMemberToken", () => {
  it("logs the Memberstack status (never the token) on 401/403/429 and still answers invalid_token", async () => {
    for (const status of [401, 403, 429]) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { status }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(verifyMemberToken(env, "secret-member-token")).rejects.toMatchObject({ status: 401, code: "invalid_token" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0])).toContain(String(status));
      expect(String(warn.mock.calls[0])).not.toContain("secret-member-token");
    }
  });
});
