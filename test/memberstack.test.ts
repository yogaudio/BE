import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteMember, getMembership, getStripeCustomerId, verifyMemberToken } from "../src/memberstack";
import shapes from "../dev/fixtures/memberstack-member-shapes.json";
import { IDS, mockAccountUpstreams, mockMemberstack } from "./helpers";

const ctx = () => createExecutionContext();
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const id of Object.values(IDS)) await env.CACHE.delete(`ms:${id}`);
});

describe("getMembership", () => {
  it("active, inactive and past-due fixtures", async () => {
    mockMemberstack();
    expect(await getMembership(env, ctx(), IDS.active)).toMatchObject({ active: true, stale: false, email: "user-1@example.com" });
    expect(await getMembership(env, ctx(), IDS.inactive)).toMatchObject({ active: false, stale: false });
    expect(await getMembership(env, ctx(), IDS.pastDue)).toMatchObject({ active: false, stale: false });
  });

  it("ALLOWED_PLAN_IDS restricts the plan", async () => {
    mockMemberstack();
    expect((await getMembership({ ...env, ALLOWED_PLAN_IDS: "pln_other" }, ctx(), IDS.active)).active).toBe(false);
    await env.CACHE.delete(`ms:${IDS.active}`);
    expect((await getMembership({ ...env, ALLOWED_PLAN_IDS: "pln_x, pln_free-plan-6aap0jr6" }, ctx(), IDS.active)).active).toBe(true);
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
      env.CACHE.put(`ms:${IDS.active}`, JSON.stringify({ active: true, email: "user-1@example.com", at: Date.now() - ageMs }));

    it("uses a cached entry under 24h old when Memberstack is down, marked stale", async () => {
      await seed(2 * 3600_000);
      mockMemberstack({ down: true });
      expect(await getMembership(env, ctx(), IDS.active)).toEqual({ active: true, stale: true, email: "user-1@example.com" });
    });

    it("throws upstream_unavailable over 24h old or with no cache", async () => {
      mockMemberstack({ down: true });
      await seed(25 * 3600_000);
      await expect(getMembership(env, ctx(), IDS.active)).rejects.toMatchObject({ status: 502, code: "upstream_unavailable" });
      await env.CACHE.delete(`ms:${IDS.active}`);
      await expect(getMembership(env, ctx(), IDS.active)).rejects.toMatchObject({ status: 502, code: "upstream_unavailable" });
    });

    it("a fresh inactive entry is rechecked, so a renewal unlocks at once", async () => {
      await env.CACHE.put(`ms:${IDS.active}`, JSON.stringify({ active: false, email: "user-1@example.com", at: Date.now() - 60_000 }));
      const calls: string[] = [];
      mockMemberstack({ calls });
      expect(await getMembership(env, ctx(), IDS.active)).toEqual({ active: true, stale: false, email: "user-1@example.com" });
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

// Membership rule v2 against the real-shape member fixtures. Each shape gets a fresh cache key.
describe("membership rule v2 (member shapes)", () => {
  type Shape = (typeof shapes)[keyof typeof shapes];
  const withShape = async (shape: Shape, envOverrides: Record<string, string> = {}) => {
    await env.CACHE.delete(`ms:${shape.id}`);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: shape }));
    return getMembership({ ...env, ...envOverrides }, ctx(), shape.id);
  };
  const withStatus = (status: string): Shape => {
    const s = structuredClone(shapes.freeActive);
    s.planConnections[0].status = status;
    return s;
  };

  it("free ACTIVE plan is active", async () => {
    expect(await withShape(shapes.freeActive)).toEqual({ active: true, stale: false, email: "user-1@example.com" });
  });

  it("TRIALING is active", async () => {
    expect(await withShape(withStatus("TRIALING"))).toMatchObject({ active: true, stale: false });
  });

  it("no plan connections is inactive", async () => {
    expect(await withShape(shapes.noPlan)).toMatchObject({ active: false, stale: false });
  });

  it("CANCELED is inactive", async () => {
    expect(await withShape(shapes.canceled)).toMatchObject({ active: false, stale: false });
  });

  it("REQUIRES_PAYMENT is inactive", async () => {
    expect(await withShape(shapes.requiresPayment)).toMatchObject({ active: false, stale: false });
  });

  it("PAST_DUE is inactive", async () => {
    expect(await withShape(withStatus("PAST_DUE"))).toMatchObject({ active: false, stale: false });
  });

  it("mixed connections (ACTIVE free plus CANCELED) is active", async () => {
    expect(await withShape(shapes.multipleConnections)).toMatchObject({ active: true, stale: false });
  });

  it("status compare is case-insensitive: 'active' matches the var ACTIVE", async () => {
    expect(await withShape(withStatus("active"), { ACTIVE_PLAN_STATUSES: "ACTIVE" })).toMatchObject({ active: true });
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

describe("getStripeCustomerId", () => {
  it("returns the id", async () => {
    mockAccountUpstreams();
    expect(await getStripeCustomerId(env, IDS.active)).toBe("cus_fake_active");
  });
  it("null when the member has no field", async () => {
    mockAccountUpstreams();
    expect(await getStripeCustomerId(env, IDS.inactive)).toBeNull();
  });
  it("'gone' on 404", async () => {
    mockAccountUpstreams();
    expect(await getStripeCustomerId(env, "mem_nobody")).toBe("gone");
  });
  it("500 throws upstream_unavailable", async () => {
    mockAccountUpstreams({ memberGetStatus: 500 });
    await expect(getStripeCustomerId(env, IDS.active)).rejects.toMatchObject({ status: 502, code: "upstream_unavailable" });
  });
});

describe("deleteMember", () => {
  it("204 is OK, then the member is gone", async () => {
    mockAccountUpstreams();
    await deleteMember(env, IDS.active);
    expect(await getStripeCustomerId(env, IDS.active)).toBe("gone");
  });
  it("404 is OK", async () => {
    mockAccountUpstreams();
    await expect(deleteMember(env, "mem_nobody")).resolves.toBeUndefined();
  });
  it("500 throws upstream_unavailable", async () => {
    mockAccountUpstreams({ memberDeleteStatus: 500 });
    await expect(deleteMember(env, IDS.active)).rejects.toMatchObject({ status: 502, code: "upstream_unavailable" });
  });
});
