import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadWebflowCollections } from "../src/webflow";
import { mockWebflow } from "./helpers";

beforeEach(() => vi.restoreAllMocks());

describe("loadWebflowCollections", () => {
  it("loads the four collections from their ids, following offset across pages", async () => {
    const calls: string[] = [];
    mockWebflow({ pageSize: 20, calls });
    const raw = await loadWebflowCollections(env);
    expect(raw.classes).toHaveLength(52);
    expect(raw.styles).toHaveLength(7);
    expect(raw.focusAreas).toHaveLength(18);
    expect(raw.durations).toHaveLength(10);
    expect(calls.every((c) => c.includes("limit=100"))).toBe(true);
    const classCalls = calls.filter((c) => c.includes("/collections/fake-collection/"));
    expect(classCalls.map((c) => new URL(`http://x${c}`).searchParams.get("offset"))).toEqual(["0", "20", "40"]);
    for (const id of ["fake-styles", "fake-focus", "fake-durations"]) expect(calls.some((c) => c.includes(`/collections/${id}/`))).toBe(true);
  });

  it("skips drafts and archived items, keeps Webflow order, exposes id and fieldData", async () => {
    const mk = (id: string, o: object = {}) => ({ id, isDraft: false, isArchived: false, fieldData: { name: id }, ...o });
    mockWebflow({ collections: {
      "fake-collection": [mk("a"), mk("b", { isDraft: true }), mk("c", { isArchived: true }), mk("d")],
      "fake-styles": [], "fake-focus": [], "fake-durations": [],
    } });
    const raw = await loadWebflowCollections(env);
    expect(raw.classes.map((i) => i.id)).toEqual(["a", "d"]);
    expect(raw.classes[0]).toMatchObject({ id: "a", fieldData: { name: "a" } });
  });

  it("a failure on any one collection (5xx, 4xx, network) is 502", async () => {
    for (const failCollection of ["fake-collection", "fake-styles", "fake-focus", "fake-durations"]) {
      vi.restoreAllMocks();
      mockWebflow({ failCollection });
      await expect(loadWebflowCollections(env), failCollection).rejects.toMatchObject({ status: 502, code: "upstream_unavailable" });
    }
    vi.restoreAllMocks();
    mockWebflow({ status: 401 });
    await expect(loadWebflowCollections(env)).rejects.toMatchObject({ status: 502 });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(loadWebflowCollections(env)).rejects.toMatchObject({ status: 502 });
  });
});
