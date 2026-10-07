import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadWebflowCategories, loadWebflowItems } from "../src/webflow";
import { mockWebflow } from "./helpers";

beforeEach(() => vi.restoreAllMocks());

describe("loadWebflowItems", () => {
  it("follows offset across 3 pages with limit 100", async () => {
    const calls: string[] = [];
    mockWebflow({ pageSize: 4, calls });
    const items = await loadWebflowItems(env);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.includes("/v2/collections/fake-collection/items/live") && c.includes("limit=100"))).toBe(true);
    expect(calls.map((c) => new URL(`http://x${c}`).searchParams.get("offset"))).toEqual(["0", "4", "8"]);
    expect(items.map((i) => i.id)).toContain("wf_good_1");
    expect(items.map((i) => i.id)).toContain("wf_bad_no_audio"); // last page was read
  });

  it("skips drafts and archived items, keeps Webflow order, exposes the raw audio field", async () => {
    mockWebflow();
    const items = await loadWebflowItems(env);
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain("wf_bad_draft");
    expect(ids).not.toContain("wf_bad_archived");
    expect(ids.slice(0, 4)).toEqual(["wf_good_1", "wf_good_2", "wf_good_3", "wf_transistor_id"]);
    expect(items[0]).toMatchObject({ slug: "sample-class-1", title: "Sample class 1", audio: expect.stringContaining("media.transistor.fm") });
    expect(items.find((i) => i.id === "wf_transistor_id")!.audio).toBe("ep_fake_1");
  });

  it("reads field slugs from the WF_FIELD_* vars", async () => {
    mockWebflow({ collections: { "fake-collection": [{ id: "a", isDraft: false, isArchived: false, fieldData: { slug: "s", headline: "T", mp3: "x" } }] } });
    const [i] = await loadWebflowItems({ ...env, WF_FIELD_TITLE: "headline", WF_FIELD_AUDIO: "mp3" });
    expect(i).toMatchObject({ title: "T", audio: "x" });
  });

  it("Webflow 5xx, 4xx or network failure is 502", async () => {
    for (const status of [500, 401]) {
      vi.restoreAllMocks();
      mockWebflow({ status });
      await expect(loadWebflowItems(env)).rejects.toMatchObject({ status: 502, code: "upstream_unavailable" });
    }
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(loadWebflowItems(env)).rejects.toMatchObject({ status: 502 });
  });
});

describe("loadWebflowCategories", () => {
  it("maps category item ids to names", async () => {
    mockWebflow();
    expect(await loadWebflowCategories(env)).toEqual([
      { id: "cat_gentle", name: "Gentle Flow" },
      { id: "cat_evening", name: "Evening Wind Down" },
      { id: "cat_morning", name: "Morning Energy" },
    ]);
  });

  it("is empty with no fetch when WF_CATEGORY_COLLECTION_ID is empty", async () => {
    const spy = mockWebflow();
    expect(await loadWebflowCategories({ ...env, WF_CATEGORY_COLLECTION_ID: "" })).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
