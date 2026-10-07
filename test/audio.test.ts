import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAudioIndex } from "../src/audio";
import { normalizeCatalog } from "../src/catalog";
import { route } from "../src/index";
import { signAccessToken } from "../src/tokens";
import type { WebflowItem } from "../src/webflow";
import { IDS, mockMemberstack, mockWebflow } from "./helpers";

// One fetch mock for Memberstack + Webflow + Transistor, dispatched by path.
function mockAll(opts: { transistorStatus?: number; calls?: string[]; collections?: Record<string, unknown[]> } = {}) {
  const calls = opts.calls ?? [];
  // both helpers spy on the same fetch, so grab each implementation before the next one replaces it
  const ms_impl = mockMemberstack({ calls }).getMockImplementation()!;
  const wf_impl = mockWebflow({ calls, transistorStatus: opts.transistorStatus, collections: opts.collections }).getMockImplementation()!;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    return (path.startsWith("/memberstack/") || path.includes("/members/") ? ms_impl : wf_impl)(input, init);
  });
}

async function play(classId: string, who: string | null = IDS.active, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (who) headers.Authorization = `Bearer ${await signAccessToken(env, who)}`;
  const ctx = createExecutionContext();
  const res = await route(new Request(`https://api.test/play/${classId}`, { headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const transistorCalls = (calls: string[]) => calls.filter((c) => c.includes("/transistor/"));

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.CACHE.delete("catalog:v1");
  await env.CACHE.delete("ep:ep_fake_1");
  for (const id of Object.values(IDS)) await env.CACHE.delete(`ms:${id}`);
});

describe("GET /play/:classId", () => {
  it("an active member gets the url; durationSec and expiresAt are null for a direct url", async () => {
    mockAll();
    const res = await play("wf_good_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://media.transistor.fm/54b166cd/dfa54a0f.mp3", durationSec: null, expiresAt: null });
  });

  it("an inactive member is 403 membership_inactive", async () => {
    mockAll();
    const res = await play("wf_good_1", IDS.inactive);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "membership_inactive" });
  });

  it("a past-due member (default statuses) gets the url", async () => {
    mockAll();
    expect((await play("wf_good_1", IDS.pastDue)).status).toBe(200);
  });

  it("401 without a token or with a bad one; checked before anything else", async () => {
    const spy = mockAll();
    expect((await play("wf_good_1", null)).status).toBe(401);
    const bad = await play("wf_good_1", null, "garbage");
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_token" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unknown class, a draft and a class with no audio are all 404 not_found", async () => {
    mockAll();
    for (const id of ["nope", "wf_bad_draft", "wf_bad_no_audio", "wf_bad_no_title", "constructor"]) {
      const res = await play(id);
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("an inactive member asking for an unknown class is 403 (membership is checked first)", async () => {
    mockAll();
    expect((await play("nope", IDS.inactive)).status).toBe(403);
  });

  it("a direct-url item makes no Transistor call", async () => {
    const calls: string[] = [];
    const items = [{ id: "d", isDraft: false, isArchived: false, fieldData: { name: "D", slug: "d", audio: "https://media.transistor.fm/d.mp3" } }];
    mockAll({ calls, collections: { "fake-collection": items, "fake-categories": [] } });
    expect((await play("d")).status).toBe(200);
    expect(transistorCalls(calls)).toEqual([]);
  });

  it("an episode-id item calls Transistor once, then is served from KV, also across catalog rebuilds", async () => {
    const calls: string[] = [];
    mockAll({ calls });
    const res = await play("wf_transistor_id");
    expect(await res.json()).toEqual({ url: "https://media.transistor.fm/54b166cd/dfa54a0f.mp3", durationSec: 1629, expiresAt: null });
    await play("wf_transistor_id");
    await env.CACHE.delete("catalog:v1"); // force a rebuild
    expect((await play("wf_transistor_id")).status).toBe(200);
    expect(transistorCalls(calls)).toHaveLength(1);
    expect(await env.CACHE.get("ep:ep_fake_1", "json")).toEqual({ url: "https://media.transistor.fm/54b166cd/dfa54a0f.mp3", durationSec: 1629 });
  });

  it("Transistor 500 with nothing cached is 502 upstream_unavailable", async () => {
    mockAll({ transistorStatus: 500 });
    const res = await play("wf_good_1");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
  });

  it("a Transistor outage during a rebuild keeps serving the stale catalog and its audio", async () => {
    mockAll();
    expect((await play("wf_transistor_id")).status).toBe(200);
    const cached = (await env.CACHE.get("catalog:v1", "json")) as any;
    const staleAt = Date.now() - 11 * 60_000;
    await env.CACHE.put("catalog:v1", JSON.stringify({ ...cached, builtAt: staleAt }));
    await env.CACHE.delete("ep:ep_fake_1");
    vi.restoreAllMocks();
    mockAll({ transistorStatus: 500 });
    expect((await play("wf_transistor_id")).status).toBe(200);
    expect(((await env.CACHE.get("catalog:v1", "json")) as any).builtAt).toBe(staleAt);
  });

  it("an unknown episode id (Transistor 404) leaves that class out of the catalog and 404s on play", async () => {
    const items = [{ id: "x", isDraft: false, isArchived: false, fieldData: { name: "X", slug: "x", audio: "ep_missing" } }];
    mockAll({ collections: { "fake-collection": items, "fake-categories": [] } });
    expect((await play("x")).status).toBe(404);
  });
});

const epItems = (ids: string[]) => ids.map((id) => ({ id: `c_${id}`, isDraft: false, isArchived: false, fieldData: { name: id, slug: id, audio: id } }));

describe("Transistor failure classes", () => {
  const cols = (ids: string[]) => ({ "fake-collection": [...epItems(ids), ...epItems(["ep_fake_1"])], "fake-categories": [] });
  for (const status of [400, 403, 422]) {
    it(`Transistor ${status} for one item drops only that item; the build succeeds`, async () => {
      const real = mockAll({ collections: cols(["bad"]) }).getMockImplementation()!;
      vi.spyOn(globalThis, "fetch").mockImplementation((i, init) =>
        String(i).endsWith("/episodes/bad") ? Promise.resolve(Response.json({}, { status })) : real(i, init));
      expect((await play("c_bad")).status).toBe(404);
      expect((await play("c_ep_fake_1")).status).toBe(200);
    });
  }

  it("Transistor 429 and 401 are transient: build fails 502, stale kept", async () => {
    for (const status of [429, 401]) {
      await env.CACHE.delete("catalog:v1");
      mockAll({ transistorStatus: status });
      expect((await play("wf_good_1")).status, String(status)).toBe(502);
    }
    vi.restoreAllMocks();
    mockAll();
    expect((await play("wf_transistor_id")).status).toBe(200);
    const cached = (await env.CACHE.get("catalog:v1", "json")) as any;
    const staleAt = Date.now() - 11 * 60_000;
    await env.CACHE.put("catalog:v1", JSON.stringify({ ...cached, builtAt: staleAt }));
    await env.CACHE.delete("ep:ep_fake_1");
    vi.restoreAllMocks();
    mockAll({ transistorStatus: 429 });
    expect((await play("wf_transistor_id")).status).toBe(200);
    expect(((await env.CACHE.get("catalog:v1", "json")) as any).builtAt).toBe(staleAt);
  });

  it("at most 4 Transistor lookups are in flight at once", async () => {
    const ids = Array.from({ length: 14 }, (_, n) => `ep_x${n}`);
    const real = mockAll({ collections: cols(ids) }).getMockImplementation()!;
    let now = 0, peak = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (i, init) => {
      if (!String(i).includes("/transistor/")) return real(i, init);
      peak = Math.max(peak, ++now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return real(i, init);
    });
    expect((await play("c_ep_fake_1")).status).toBe(200);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("an ep: entry's TTL is jittered around 24 h", async () => {
    mockAll();
    const put = vi.spyOn(env.CACHE, "put");
    await play("wf_transistor_id");
    const ttl = (put.mock.calls.find((c) => c[0] === "ep:ep_fake_1")![2] as any).expirationTtl;
    expect(ttl).toBeGreaterThanOrEqual(18 * 3600);
    expect(ttl).toBeLessThanOrEqual(30 * 3600);
  });

  it("a malformed class id is 404 not_found, not 500", async () => {
    mockAll();
    const res = await play("%E0%A4");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("/catalog and audio", () => {
  it("a class with an empty audio field is absent from /catalog; the other classes stay", async () => {
    mockAll();
    const ctx = createExecutionContext();
    const res = await route(new Request("https://api.test/catalog", { headers: { Authorization: `Bearer ${await signAccessToken(env, IDS.active)}` } }), env, ctx);
    const ids = ((await res.json()) as any).classes.map((c: any) => c.id);
    expect(ids).not.toContain("wf_bad_no_audio");
    expect(ids).toContain("wf_good_1");
    expect(ids).toContain("wf_transistor_id");
  });

  it("the audio index never reaches the /catalog body or its ETag", async () => {
    mockAll();
    const ctx = createExecutionContext();
    const res = await route(new Request("https://api.test/catalog", { headers: { Authorization: `Bearer ${await signAccessToken(env, IDS.active)}` } }), env, ctx);
    const text = await res.text();
    expect(text).not.toContain("media.transistor.fm");
    expect(text).not.toContain("ep_fake_1");
  });
});

const item = (o: Partial<WebflowItem> = {}): WebflowItem => ({
  id: "i1", slug: "s", title: "T", duration: null, category: [], teacher: null, image: null, description: null, audio: "https://media.transistor.fm/a.mp3", ...o,
});

describe("buildAudioIndex / normalizeCatalog", () => {
  it("indexes direct urls and episode ids (also from a share url); skips junk", async () => {
    mockAll();
    const idx = await buildAudioIndex(env, [
      item({ id: "a" }),
      item({ id: "b", audio: "ep_fake_1" }),
      item({ id: "c", audio: "https://share.transistor.fm/s/ep_fake_1" }),
      item({ id: "d", audio: "" }),
      item({ id: "e", audio: "http://media.transistor.fm/a.mp3" }),
      item({ id: "f", audio: "https://evil.example/a.mp3" }),
      item({ id: "g", audio: { x: 1 } }),
    ]);
    expect([...idx.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(idx.get("b")).toEqual({ url: "https://media.transistor.fm/54b166cd/dfa54a0f.mp3", durationSec: 1629 });
  });

  it("normalizeCatalog drops classes absent from the index and fills only a null duration from it", () => {
    const idx = new Map([
      ["a", { url: "u", durationSec: 99 }],
      ["b", { url: "u", durationSec: 99 }],
      ["c", { url: "u", durationSec: null }],
    ]);
    const out = normalizeCatalog([item({ id: "a" }), item({ id: "b", duration: 600 }), item({ id: "c" }), item({ id: "z" })], idx);
    expect(out.classes.map((c) => [c.id, c.durationSec])).toEqual([["a", 99], ["b", 600], ["c", null]]);
  });
});
