import { env } from "cloudflare:test";
import { vi } from "vitest";
import episodes from "../dev/fixtures/transistor-episodes.json";
import members from "../dev/fixtures/members.json";
import webflow from "../dev/fixtures/webflow-items.json";

// Fake Memberstack on top of globalThis.fetch, same shapes as dev/fake-upstreams.mjs.
export function mockMemberstack(opts: { down?: boolean; calls?: string[]; overrides?: Record<string, unknown> } = {}) {
  const calls = opts.calls ?? [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (opts.down) throw new TypeError("fetch failed");
    if (url.pathname.endsWith("/members/verify-token")) {
      const m = (members as Record<string, { id: string }>)[JSON.parse(String(init?.body)).token];
      return m ? Response.json({ data: { id: m.id } }) : Response.json({ message: "invalid" }, { status: 401 });
    }
    const id = url.pathname.split("/").pop();
    const m = Object.values(members).find((x) => x.id === id);
    return m ? Response.json({ data: { ...m, ...opts.overrides } }) : Response.json({}, { status: 404 });
  });
}

export const IDS = { active: "mem_fake_active", inactive: "mem_fake_inactive", pastDue: "mem_fake_pastdue" };

// Fake Webflow Data API on top of globalThis.fetch, same shapes as dev/fake-upstreams.mjs.
// `pageSize` caps items per page (real Webflow caps at 100) so pagination is testable with the small fixture.
// It also fakes Transistor episode lookups (x-api-key auth); `transistorStatus` forces that service's response status.
export function mockWebflow(opts: { pageSize?: number; status?: number; transistorStatus?: number; calls?: string[]; collections?: Record<string, unknown[]> } = {}) {
  const calls = opts.calls ?? [];
  const collections = opts.collections ?? {
    "fake-collection": webflow.items,
    [webflow.categoryCollection]: webflow.categories,
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/transistor/")) {
      if (opts.transistorStatus) return Response.json({ message: "boom" }, { status: opts.transistorStatus });
      if ((init?.headers as Record<string, string>)?.["x-api-key"] !== env.TRANSISTOR_API_KEY) return Response.json({}, { status: 401 });
      const ep = (episodes as Record<string, unknown>)[url.pathname.split("/").pop()!];
      return ep ? Response.json({ data: ep }) : Response.json({ message: "not found" }, { status: 404 });
    }
    if (opts.status) return Response.json({ message: "boom" }, { status: opts.status });
    const all = collections[url.pathname.split("/")[4]];
    if (!all) return Response.json({ message: "collection not found" }, { status: 404 });
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), opts.pageSize ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return Response.json({ items: all.slice(offset, offset + limit), pagination: { limit, offset, total: all.length } });
  });
}
