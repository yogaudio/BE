import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCatalog } from "../src/catalog";
import { route } from "../src/index";
import { signAccessToken } from "../src/tokens";
import type { WebflowItem } from "../src/webflow";
import { mockWebflow } from "./helpers";

const item = (o: Partial<WebflowItem> = {}): WebflowItem => ({
  id: "i1", slug: "s1", title: "T", duration: "10:00", category: [], teacher: null, image: null, description: null, audio: "https://media.transistor.fm/a/b.mp3", ...o,
});
const cats = [{ id: "c1", name: "One" }];
const one = (o: Partial<WebflowItem>) => normalizeCatalog([item(o)], undefined, cats).classes[0];

describe("normalizeCatalog", () => {
  it("duration: seconds, mm:ss, hh:mm:ss; anything else null", () => {
    expect(one({ duration: 1800 })?.durationSec).toBe(1800);
    expect(one({ duration: "27:09" })?.durationSec).toBe(27 * 60 + 9);
    expect(one({ duration: "1:02:03" })?.durationSec).toBe(3723);
    for (const bad of ["about half an hour", "", "12:75", "1:2:3:4", -5, NaN, null, undefined, {}, "0:00", 0.4]) {
      expect(one({ duration: bad })?.durationSec, String(bad)).toBeNull();
    }
  });

  it("skips an item with no title, blank title or no id; keeps order", () => {
    const out = normalizeCatalog([item({ id: "a" }), item({ id: "b", title: undefined }), item({ id: "c", title: "  " }), item({ id: "d" })]);
    expect(out.classes.map((c) => c.id)).toEqual(["a", "d"]);
  });

  it("drops unknown category refs, accepts a single ref or an array", () => {
    expect(one({ category: ["c1", "nope"] })?.categoryIds).toEqual(["c1"]);
    expect(one({ category: "c1" })?.categoryIds).toEqual(["c1"]);
    expect(one({ category: "nope" })?.categoryIds).toEqual([]);
    expect(one({ category: undefined })?.categoryIds).toEqual([]);
  });

  it("artworkUrl is kept only when https; accepts a Webflow image object", () => {
    expect(one({ image: { url: "https://cdn.example.test/a.jpg" } })?.artworkUrl).toBe("https://cdn.example.test/a.jpg");
    expect(one({ image: "https://cdn.example.test/a.jpg" })?.artworkUrl).toBe("https://cdn.example.test/a.jpg");
    expect(one({ image: { url: "http://cdn.example.test/a.jpg" } })?.artworkUrl).toBeNull();
    expect(one({ image: "javascript:alert(1)" })?.artworkUrl).toBeNull();
    expect(one({ image: null })?.artworkUrl).toBeNull();
  });

  it("teacher and description are strings or null; shape matches the contract", () => {
    expect(one({ teacher: " Elliott ", description: "<p>Hi</p>" })).toEqual({
      id: "i1", slug: "s1", title: "T", durationSec: 600, categoryIds: [], teacher: "Elliott", artworkUrl: null, description: "Hi",
    });
    expect(one({ teacher: 5, description: "" })).toMatchObject({ teacher: null, description: null });
  });

  it("description is plain text: tags stripped, entities decoded, whitespace collapsed", () => {
    expect(one({ description: "<p>Slow &amp; steady</p>\n<p>a&nbsp;&lt;b&gt; &quot;q&quot; it&#39;s</p>" })?.description).toBe(`Slow & steady a <b> "q" it's`);
    expect(one({ description: "<p> </p>" })?.description).toBeNull();
  });

  it("description is null when it mentions transistor.fm", () => {
    expect(one({ description: '<p>Listen <a href="https://share.transistor.fm/s/abc">here</a></p>' })?.description).toBeNull();
    expect(one({ description: "see Transistor.FM/xyz" })?.description).toBeNull();
  });

  it("audioIndex absent drops nothing; the output never carries audio", () => {
    const out = normalizeCatalog([item({ audio: "" })], undefined, cats);
    expect(out.classes).toHaveLength(1);
    expect(JSON.stringify(normalizeCatalog([item()], undefined, cats))).not.toMatch(/transistor|audio/);
  });

  it("returns the categories it was given", () => {
    expect(normalizeCatalog([], undefined, cats).categories).toEqual(cats);
  });
});

// --- GET /catalog ---

const TOKEN = () => signAccessToken(env, "mem_fake_active");
async function get(headers: Record<string, string> = {}, e = env) {
  const ctx = createExecutionContext();
  const res = await route(new Request("https://api.test/catalog", { headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const authed = async (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${await TOKEN()}`, ...extra });
const seed = (ageMs: number, version = "seeded") =>
  env.CACHE.put("catalog:v1", JSON.stringify({ version, builtAt: Date.now() - ageMs, json: JSON.stringify({ version, classes: [], categories: [] }) }));

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.CACHE.delete("catalog:v1");
});

describe("GET /catalog", () => {
  it("401 invalid_token without a Bearer", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("builds from Webflow, caches in KV, sets ETag = version", async () => {
    const calls: string[] = [];
    mockWebflow({ calls });
    const res = await get(await authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(res.headers.get("ETag")).toBe(`"${body.version}"`);
    expect(body.version).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(body.categories).toHaveLength(3);
    expect(body.classes.map((c: any) => c.id)).toEqual([
      "wf_good_1", "wf_good_2", "wf_good_3", "wf_transistor_id", "wf_bad_duration", "wf_bad_category", "wf_bad_image",
    ]);
    expect(body.classes[0]).toEqual({
      id: "wf_good_1", slug: "sample-class-1", title: "Sample class 1", durationSec: 1629, categoryIds: ["cat_gentle"],
      teacher: "Elliott Rader", artworkUrl: "https://cdn.example.test/img1.jpg", description: "A slow, steady practice.",
    });
    expect(body.classes.find((c: any) => c.id === "wf_bad_duration").durationSec).toBeNull();
    expect(body.classes.find((c: any) => c.id === "wf_bad_category").categoryIds).toEqual([]);
    expect(body.classes.find((c: any) => c.id === "wf_bad_image").artworkUrl).toBeNull();
    const cached = (await env.CACHE.get("catalog:v1", "json")) as any;
    expect(cached).toMatchObject({ version: body.version });
    expect(typeof cached.builtAt).toBe("number");
    expect(JSON.parse(cached.json)).toEqual(body);
  });

  it("the catalog JSON contains no audio URL, Transistor id or audio field", async () => {
    mockWebflow();
    const text = await (await get(await authed())).text();
    expect(text).not.toContain("media.transistor.fm");
    expect(text).not.toContain("ep_fake_1");
    expect(text).not.toMatch(/"[^"]*audio[^"]*"\s*:/i); // no audio key (a title may say "audio")
  });

  it("a fresh cache makes no Webflow fetch", async () => {
    await seed(60_000);
    const spy = mockWebflow();
    const res = await get(await authed());
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).version).toBe("seeded");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a stale cache is served at once and a rebuild runs via waitUntil", async () => {
    await seed(11 * 60_000);
    const calls: string[] = [];
    mockWebflow({ calls });
    const ctx = createExecutionContext();
    const res = await route(new Request("https://api.test/catalog", { headers: await authed() }), env, ctx);
    expect(((await res.json()) as any).version).toBe("seeded");
    await waitOnExecutionContext(ctx);
    expect(calls.length).toBeGreaterThan(0);
    const cached = (await env.CACHE.get("catalog:v1", "json")) as any;
    expect(cached.version).not.toBe("seeded");
    expect(Date.now() - cached.builtAt).toBeLessThan(60_000);
  });

  it("no cache plus a Webflow 500 is 502", async () => {
    mockWebflow({ status: 500 });
    const res = await get(await authed());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
  });

  it("stale catalog on upstream error: the stale cache is served and left in place", async () => {
    await seed(11 * 60_000);
    mockWebflow({ status: 500 });
    const res = await get(await authed());
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).version).toBe("seeded");
    expect(((await env.CACHE.get("catalog:v1", "json")) as any).version).toBe("seeded");
  });

  it("If-None-Match equal to the version is 304 with no body", async () => {
    await seed(1000, "v123");
    const res = await get(await authed({ "If-None-Match": '"v123"' }));
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("ETag")).toBe('"v123"');
    expect((await get(await authed({ "If-None-Match": '"other"' }))).status).toBe(200);
  });
});
