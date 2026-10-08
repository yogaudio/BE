import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelLiveSubscriptions } from "../src/stripe";
import { mockAccountUpstreams } from "./helpers";

beforeEach(() => vi.restoreAllMocks());

const deletes = (calls: string[]) => calls.filter((c) => c.startsWith("DELETE"));

describe("cancelLiveSubscriptions", () => {
  it("cancels only live statuses", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    expect(await cancelLiveSubscriptions(env, "cus_fake_active")).toBe(1);
    expect(deletes(calls)).toEqual(["DELETE /stripe/v1/subscriptions/sub_fake_active"]);
  });
  it("cancels past_due and trialing", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    expect(await cancelLiveSubscriptions(env, "cus_fake_pastdue")).toBe(2);
    expect(deletes(calls)).toHaveLength(2);
  });
  it("returns 0 with no DELETE when nothing is live", async () => {
    const calls: string[] = [];
    mockAccountUpstreams({ calls });
    expect(await cancelLiveSubscriptions(env, "cus_fake_active")).toBe(1);
    calls.length = 0;
    expect(await cancelLiveSubscriptions(env, "cus_fake_active")).toBe(0);
    expect(deletes(calls)).toHaveLength(0);
  });
  it("a list 404 returns 0", async () => {
    mockAccountUpstreams();
    expect(await cancelLiveSubscriptions(env, "cus_unknown")).toBe(0);
  });
  it("a cancel 404 counts as success", async () => {
    const real = mockAccountUpstreams();
    const impl = real.getMockImplementation()!;
    real.mockImplementation(async (i, init) =>
      init?.method === "DELETE" ? Response.json({}, { status: 404 }) : impl(i, init));
    expect(await cancelLiveSubscriptions(env, "cus_fake_pastdue")).toBe(2);
  });
  it("a list 500 throws stripe_unavailable", async () => {
    mockAccountUpstreams({ stripeStatus: 500 });
    await expect(cancelLiveSubscriptions(env, "cus_fake_active")).rejects.toMatchObject({ status: 502, code: "stripe_unavailable" });
  });
  it("a 401 throws stripe_unavailable and logs status only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAccountUpstreams({ stripeStatus: 401 });
    await expect(cancelLiveSubscriptions(env, "cus_fake_active")).rejects.toMatchObject({ code: "stripe_unavailable" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("rk_fake_stripe");
    expect(warn).toHaveBeenCalled();
  });
  it("a network error throws stripe_unavailable", async () => {
    mockAccountUpstreams({ stripeDown: true });
    await expect(cancelLiveSubscriptions(env, "cus_fake_active")).rejects.toMatchObject({ status: 502, code: "stripe_unavailable" });
  });
  it("sends the Bearer key", async () => {
    const spy = mockAccountUpstreams();
    await cancelLiveSubscriptions(env, "cus_fake_active");
    for (const [, init] of spy.mock.calls) expect(new Headers(init!.headers).get("authorization")).toBe("Bearer rk_fake_stripe");
  });
});

describe("cancelLiveSubscriptions paging", () => {
  it("has_more fails closed with stripe_unavailable and cancels nothing", async () => {
    const calls: string[] = [];
    const real = mockAccountUpstreams({ calls });
    const impl = real.getMockImplementation()!;
    real.mockImplementation(async (i, init) => {
      const res = await impl(i, init);
      return init?.method === "DELETE" ? res : Response.json({ ...((await res.json()) as object), has_more: true });
    });
    await expect(cancelLiveSubscriptions(env, "cus_fake_active")).rejects.toMatchObject({ status: 502, code: "stripe_unavailable" });
    expect(deletes(calls)).toHaveLength(0);
  });
});
