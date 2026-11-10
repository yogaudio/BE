import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import wfClasses from "../dev/fixtures/webflow-classes.json";
import wfDurations from "../dev/fixtures/webflow-durations.json";
import wfFocus from "../dev/fixtures/webflow-focus-areas.json";
import wfStyles from "../dev/fixtures/webflow-styles.json";
import { normalizeCatalog } from "../src/catalog";
import { route } from "../src/index";
import { signAccessToken } from "../src/tokens";
import type { WebflowCollections } from "../src/webflow";
import { mockWebflow } from "./helpers";

type Raw = { id: string; fieldData: Record<string, unknown> };
const it_ = (id: string, fieldData: Record<string, unknown>): Raw => ({ id, fieldData });
const AUDIO = "https://media.transistor.fm/a/b.mp3";
const real = (): WebflowCollections => ({ classes: wfClasses.items, styles: wfStyles.items, focusAreas: wfFocus.items, durations: wfDurations.items }) as WebflowCollections;
// Small synthetic world: styles s1 "yin" s2 "Vinyasa" s3 "ashtanga"; focus f1; durations d15 (name only), d10 (numeric), dbad.
const world = (classes: Raw[]): WebflowCollections => ({
  classes,
  styles: [it_("s2", { name: "Vinyasa" }), it_("s1", { name: "yin" }), it_("s3", { name: "ashtanga" })],
  focusAreas: [it_("f2", { name: "Balance" }), it_("f1", { name: "back" })],
  durations: [it_("d15", { name: "15", duration: null }), it_("d10", { name: "10", duration: 10 }), it_("dbad", { name: "abc", duration: null })],
});
const cls = (o: Record<string, unknown> = {}, id = "c1") =>
  it_(id, { name: "T", slug: "t", "audio-file": AUDIO, style: [], "focus-areas": [], durations: "d10", description: "<p>Hi</p>", ...o });
const one = (o: Record<string, unknown> = {}) => normalizeCatalog(world([cls(o)])).catalog.classes[0];

describe("normalizeCatalog", () => {
  it("real fixture: 52 classes, every option list non-empty, every class has a durationId", () => {
    const { catalog, audio } = normalizeCatalog(real());
    expect(catalog.classes).toHaveLength(52);
    expect(audio.size).toBe(52);
    for (const k of ["styles", "focusAreas", "durations"] as const) expect(catalog[k].length, k).toBeGreaterThan(0);
    expect(catalog.classes.every((c) => c.durationId)).toBe(true);
    expect(catalog.classes.every((c) => c.durationSec && c.durationSec > 0)).toBe(true);
    expect(catalog.durations.map((d) => d.name)).toEqual([...catalog.durations.map((d) => d.name)].sort((a, b) => Number(a) - Number(b)));
  });

  it("class shape matches the contract; audio map carries url and durationSec", () => {
    const out = normalizeCatalog(world([cls({ style: ["s1"], "focus-areas": ["f1"], durations: "d15" })]));
    expect(out.catalog.classes[0]).toEqual({
      id: "c1", slug: "t", title: "T", description: "Hi", durationSec: 900, styleIds: ["s1"], focusAreaIds: ["f1"], durationId: "d15",
    });
    expect(out.audio.get("c1")).toEqual({ url: AUDIO, durationSec: 900 });
  });

  it("classes sort by Class # descending, numerically (2, 10, 57 is not a text sort)", () => {
    const ids = normalizeCatalog(world([cls({ class: 2 }, "a"), cls({ class: 57 }, "b"), cls({ class: 10 }, "c")])).catalog.classes.map((c) => c.id);
    expect(ids).toEqual(["b", "c", "a"]);
  });

  it("missing, null or non-numeric Class # go after all numbered classes, in Webflow order", () => {
    const ids = normalizeCatalog(world([
      cls({}, "u1"), cls({ class: 3 }, "n3"), cls({ class: null }, "u2"), cls({ class: 1 }, "n1"), cls({ class: "abc" }, "u3"),
    ])).catalog.classes.map((c) => c.id);
    expect(ids).toEqual(["n3", "n1", "u1", "u2", "u3"]);
  });

  it("equal Class # keep Webflow order", () => {
    const ids = normalizeCatalog(world([cls({ class: 5 }, "a"), cls({ class: 5 }, "b"), cls({ class: 9 }, "c")])).catalog.classes.map((c) => c.id);
    expect(ids).toEqual(["c", "a", "b"]);
  });

  it("duration: numeric field wins, null numeric falls back to the name, unparseable name drops the option", () => {
    expect(one({ durations: "d10" })).toMatchObject({ durationSec: 600, durationId: "d10" });
    expect(one({ durations: "d15" })).toMatchObject({ durationSec: 900, durationId: "d15" });
    const bad = one({ durations: "dbad" });
    expect(bad).toMatchObject({ durationSec: null, durationId: null });
    const out = normalizeCatalog(world([cls({ durations: "dbad" })]));
    expect(out.catalog.durations).toEqual([]);
    expect(out.audio.get("c1")).toEqual({ url: AUDIO, durationSec: null });
  });

  it("duration: zero or negative numeric falls back to the name; a missing/unknown durations ref is null", () => {
    const w = world([cls({ durations: "dz" }), cls({ durations: "nope" }, "c2"), cls({ durations: undefined }, "c3")]);
    w.durations.push(it_("dz", { name: "20", duration: 0 }));
    const cs = normalizeCatalog(w).catalog.classes;
    expect(cs[0]).toMatchObject({ durationSec: 1200, durationId: "dz" });
    expect(cs[1]).toMatchObject({ durationSec: null, durationId: null });
    expect(cs[2]).toMatchObject({ durationSec: null, durationId: null });
  });

  it("dangling refs: unknown style dropped, others kept; unused options are absent", () => {
    const out = normalizeCatalog(world([cls({ style: ["s1", "ghost"], "focus-areas": ["ghost"] })]));
    expect(out.catalog.classes[0]).toMatchObject({ styleIds: ["s1"], focusAreaIds: [] });
    expect(out.catalog.styles).toEqual([{ id: "s1", name: "yin" }]);
    expect(out.catalog.focusAreas).toEqual([]);
    expect(out.catalog.durations.map((d) => d.id)).toEqual(["d10"]);
  });

  it("refs of the wrong type (null, string instead of array) never crash", () => {
    expect(one({ style: null, "focus-areas": "f1" })).toMatchObject({ styleIds: [], focusAreaIds: [] });
  });

  it("sorting: styles and focus areas by name case-insensitive, durations by minutes", () => {
    const out = normalizeCatalog(world([
      cls({ style: ["s2", "s1", "s3"], "focus-areas": ["f2", "f1"], durations: "d15" }),
      cls({ durations: "d10" }, "c2"),
    ]));
    expect(out.catalog.styles.map((s) => s.name)).toEqual(["ashtanga", "Vinyasa", "yin"]);
    expect(out.catalog.focusAreas.map((s) => s.name)).toEqual(["back", "Balance"]);
    expect(out.catalog.durations.map((d) => d.name)).toEqual(["10", "15"]);
  });

  it("blank description is null; a missing name skips the item; order is kept", () => {
    expect(one({ description: "  <p> </p> " })?.description).toBeNull();
    expect(one({ description: null })?.description).toBeNull();
    const out = normalizeCatalog(world([cls({}, "a"), cls({ name: undefined }, "b"), cls({ name: "  " }, "c"), cls({}, "d")]));
    expect(out.catalog.classes.map((c) => c.id)).toEqual(["a", "d"]);
  });

  it("an item without a Transistor audio URL is skipped, never listed", () => {
    for (const bad of [undefined, null, "", "ep_fake_1", "http://media.transistor.fm/a.mp3", "https://evil.example/a.mp3", "https://media.transistor.fm.evil.example/a.mp3", { url: AUDIO }]) {
      const out = normalizeCatalog(world([cls({ "audio-file": bad })]));
      expect(out.catalog.classes, String(bad)).toEqual([]);
      expect(out.audio.size).toBe(0);
    }
  });

  it("description is plain text: tags stripped, entities decoded; one that mentions transistor.fm is null", () => {
    expect(one({ description: "<p>Slow &amp; steady</p>\n<p>it&#8217;s &#x2014; ok</p>" })?.description).toBe("Slow & steady it\u2019s \u2014 ok");
    expect(one({ description: '<p>Listen <a href="https://share.transistor.fm/s/abc">here</a></p>' })?.description).toBeNull();
  });

  it("the catalog JSON has no Transistor URL, teacher, artworkUrl or categor string", () => {
    const text = JSON.stringify(normalizeCatalog(real()).catalog);
    for (const bad of ["media.transistor.fm", "teacher", "artworkUrl", "categor"]) expect(text).not.toContain(bad);
  });
});

// --- GET /catalog ---

const TOKEN = () => signAccessToken(env, "mem_fake_1");
async function get(headers: Record<string, string> = {}, e = env) {
  const ctx = createExecutionContext();
  const res = await route(new Request("https://api.test/catalog", { headers }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const authed = async (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${await TOKEN()}`, ...extra });
const seed = (ageMs: number, version = "seeded") =>
  env.CACHE.put("catalog:v2", JSON.stringify({ version, builtAt: Date.now() - ageMs, json: JSON.stringify({ version, classes: [], styles: [], focusAreas: [], durations: [] }) }));

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.CACHE.delete("catalog:v2");
  await env.CACHE.delete("catalog:rebuilding");
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
    expect(body.classes).toHaveLength(52);
    expect(body.classes[0]).toMatchObject({ id: "6ad7b26d1bf051ee351944a3", slug: "52-slow-flow-mellow-and-low", title: "#52 Slow Flow: Mellow and Low", description: null });
    expect(body.styles.length).toBeGreaterThan(0);
    expect(body.categories).toBeUndefined();
    const cached = (await env.CACHE.get("catalog:v2", "json")) as any;
    expect(cached).toMatchObject({ version: body.version });
    expect(typeof cached.builtAt).toBe("number");
    expect(JSON.parse(cached.json)).toEqual(body);
    expect(Object.keys(cached.audio)).toHaveLength(52);
    expect(cached.audio[body.classes[0].id]).toEqual({ url: "https://media.transistor.fm/00a90e00/36cad4bf.mp3", durationSec: body.classes[0].durationSec });
  });

  it("the catalog JSON contains no audio URL, Transistor id or audio field", async () => {
    mockWebflow();
    const text = await (await get(await authed())).text();
    expect(text).not.toContain("media.transistor.fm");
    expect(text).not.toContain("ep_fake_1");
    expect(text).not.toMatch(/"[^"]*audio[^"]*"\s*:/i); // no audio key (a title may say "audio")
  });

  it("an old catalog:v1 entry is ignored: v2 is built, no crash", async () => {
    await env.CACHE.put("catalog:v1", JSON.stringify({ version: "old", builtAt: Date.now(), json: "{}" }));
    mockWebflow();
    const body = (await (await get(await authed())).json()) as any;
    expect(body.version).not.toBe("old");
    expect(body.classes).toHaveLength(52);
  });

  it("a failure loading one reference collection is 502 with no cache, the stale cache with one", async () => {
    for (const failCollection of ["fake-styles", "fake-focus", "fake-durations"]) {
      await env.CACHE.delete("catalog:v2");
      mockWebflow({ failCollection });
      const res = await get(await authed());
      expect(res.status, failCollection).toBe(502);
      expect(await res.json()).toEqual({ error: "upstream_unavailable" });
      vi.restoreAllMocks();
      await seed(11 * 60_000);
      mockWebflow({ failCollection });
      const stale = await get(await authed());
      expect(stale.status, failCollection).toBe(200);
      expect(((await stale.json()) as any).version).toBe("seeded");
      expect(((await env.CACHE.get("catalog:v2", "json")) as any).version).toBe("seeded");
      vi.restoreAllMocks();
    }
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
    const cached = (await env.CACHE.get("catalog:v2", "json")) as any;
    expect(cached.version).not.toBe("seeded");
    expect(Date.now() - cached.builtAt).toBeLessThan(60_000);
  });

  it("an empty Webflow catalog never replaces the cached entry: stale is kept and served", async () => {
    await seed(11 * 60_000);
    const calls: string[] = [];
    mockWebflow({ calls, collections: { "fake-collection": [], "fake-styles": wfStyles.items, "fake-focus": wfFocus.items, "fake-durations": wfDurations.items } });
    const res = await get(await authed());
    expect(((await res.json()) as any).version).toBe("seeded");
    expect(calls.length).toBeGreaterThan(0);
    expect(((await env.CACHE.get("catalog:v2", "json")) as any).version).toBe("seeded");
  });

  it("cold cache plus an empty Webflow catalog is 502 and nothing is cached", async () => {
    mockWebflow({ collections: { "fake-collection": [], "fake-styles": [], "fake-focus": [], "fake-durations": [] } });
    const res = await get(await authed());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
    expect(await env.CACHE.get("catalog:v2")).toBeNull();
  });

  it("a stale rebuild is skipped while the rebuild lock is held, and runs without it", async () => {
    await seed(11 * 60_000);
    await env.CACHE.put("catalog:rebuilding", "1", { expirationTtl: 60 });
    const locked: string[] = [];
    mockWebflow({ calls: locked });
    expect(((await (await get(await authed())).json()) as any).version).toBe("seeded");
    expect(locked).toHaveLength(0);
    vi.restoreAllMocks();
    await env.CACHE.delete("catalog:rebuilding");
    const free: string[] = [];
    mockWebflow({ calls: free });
    await get(await authed());
    expect(free.length).toBeGreaterThan(0);
    expect(await env.CACHE.get("catalog:rebuilding")).toBeNull();
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
    expect(((await env.CACHE.get("catalog:v2", "json")) as any).version).toBe("seeded");
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
