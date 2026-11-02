import { env } from "cloudflare:test";
import { vi } from "vitest";
import members from "../dev/fixtures/members.json";
import wfClasses from "../dev/fixtures/webflow-classes.json";
import wfDurations from "../dev/fixtures/webflow-durations.json";
import wfFocus from "../dev/fixtures/webflow-focus-areas.json";
import wfStyles from "../dev/fixtures/webflow-styles.json";
import stripeSubs from "../dev/fixtures/stripe-subscriptions.json";

// Fake Memberstack on top of globalThis.fetch, same shapes as dev/fake-upstreams.mjs.
export function mockMemberstack(opts: { down?: boolean; calls?: string[]; overrides?: Record<string, unknown> } = {}) {
  const calls = opts.calls ?? [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (opts.down) throw new TypeError("fetch failed");
    if (url.pathname.endsWith("/members/verify-token")) {
      const m = (members as Record<string, { id: string }>)[JSON.parse(String(init?.body)).token];
      return m ? Response.json({ data: { id: m.id } }) : Response.json({ message: "invalid" }, { status: 400 });
    }
    const id = url.pathname.split("/").pop();
    const m = Object.values(members).find((x) => x.id === id);
    return m ? Response.json({ data: { ...m, ...opts.overrides } }) : Response.json({}, { status: 404 });
  });
}

export const IDS = { active: "mem_fake_1", noPlan: "mem_fake_2", inactive: "mem_fake_2", canceled: "mem_fake_3" };

// Fake Webflow Data API on top of globalThis.fetch, same shapes as dev/fake-upstreams.mjs.
// `pageSize` caps items per page (real Webflow caps at 100) so pagination is testable with the small fixture.
export function mockWebflow(opts: { pageSize?: number; status?: number; failCollection?: string; calls?: string[]; collections?: Record<string, unknown[]> } = {}) {
  const calls = opts.calls ?? [];
  const collections = opts.collections ?? {
    "fake-collection": wfClasses.items,
    "fake-styles": wfStyles.items,
    "fake-focus": wfFocus.items,
    "fake-durations": wfDurations.items,
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (opts.status || opts.failCollection === url.pathname.split("/")[4]) return Response.json({ message: "boom" }, { status: opts.status ?? 500 });
    const all = collections[url.pathname.split("/")[4]];
    if (!all) return Response.json({ message: "collection not found" }, { status: 404 });
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), opts.pageSize ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return Response.json({ items: all.slice(offset, offset + limit), pagination: { limit, offset, total: all.length } });
  });
}

// Fake Memberstack (GET/DELETE member) + Stripe (list/cancel subscriptions) for the account-delete flow.
// Stateful per call: a cancelled subscription then lists as canceled, a deleted member then answers 404.
// `opts` is read on every request, so a test may change it between requests.
export interface AccountUpstreamOpts {
  calls?: string[];
  stripeStatus?: number; // forces every Stripe response status
  stripeDown?: boolean; // Stripe network error
  stripeResourceMissing?: boolean; // list answers 400 with error.code resource_missing
  memberDeleteStatus?: number;
  memberGetStatus?: number;
  memberOverrides?: Record<string, unknown>; // merged into every member GET
}
export function mockAccountUpstreams(opts: AccountUpstreamOpts = {}) {
  const calls = opts.calls ?? [];
  const subs = structuredClone(stripeSubs) as Record<string, { id: string; status: string }[]>;
  const live = structuredClone(members) as Record<string, { id: string }>;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname.startsWith("/stripe/")) {
      if (opts.stripeDown) throw new TypeError("fetch failed");
      if (opts.stripeStatus) return Response.json({ error: "boom" }, { status: opts.stripeStatus });
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${env.STRIPE_RESTRICTED_KEY}`) return Response.json({}, { status: 401 });
      if (url.pathname === "/stripe/v1/subscriptions") {
        if (opts.stripeResourceMissing) return Response.json({ error: { code: "resource_missing", param: "customer" } }, { status: 400 });
        const list = subs[url.searchParams.get("customer") ?? ""];
        return list ? Response.json({ data: list }) : Response.json({ error: "no such customer" }, { status: 404 });
      }
      const sub = Object.values(subs).flat().find((s) => s.id === url.pathname.split("/").pop());
      if (!sub || method !== "DELETE") return Response.json({}, { status: 404 });
      sub.status = "canceled";
      return Response.json(sub);
    }
    const id = url.pathname.split("/").pop();
    const key = Object.keys(live).find((k) => live[k].id === id);
    if (method === "DELETE") {
      if (opts.memberDeleteStatus) return new Response(null, { status: opts.memberDeleteStatus });
      if (!key) return Response.json({}, { status: 404 });
      delete live[key];
      return new Response(null, { status: 204 });
    }
    if (opts.memberGetStatus) return Response.json({}, { status: opts.memberGetStatus });
    return key ? Response.json({ data: { ...live[key], ...opts.memberOverrides } }) : Response.json({}, { status: 404 });
  });
}
