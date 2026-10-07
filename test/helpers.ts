import { vi } from "vitest";
import members from "../dev/fixtures/members.json";

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
