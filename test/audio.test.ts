import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/index";
import { signAccessToken } from "../src/tokens";
import wfClasses from "../dev/fixtures/webflow-classes.json";
import wfDurations from "../dev/fixtures/webflow-durations.json";
import wfFocus from "../dev/fixtures/webflow-focus-areas.json";
import wfStyles from "../dev/fixtures/webflow-styles.json";
import { IDS, mockMemberstack, mockWebflow } from "./helpers";

// One fetch mock for Memberstack + Webflow, dispatched by path.
function mockAll(opts: { calls?: string[]; collections?: Record<string, unknown[]> } = {}) {
  const calls = opts.calls ?? [];
  // both helpers spy on the same fetch, so grab each implementation before the next one replaces it
  const ms_impl = mockMemberstack({ calls }).getMockImplementation()!;
  const wf_impl = mockWebflow({ calls, collections: opts.collections }).getMockImplementation()!;
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

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.CACHE.delete("catalog:v2");
  for (const id of Object.values(IDS)) await env.CACHE.delete(`ms:${id}`);
});

describe("GET /play/:classId", () => {
  it("an active member gets the audio-file url and the catalog durationSec; expiresAt is null", async () => {
    mockAll();
    const res = await play("6ad7b26d1bf051ee351944a3");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://media.transistor.fm/00a90e00/36cad4bf.mp3", durationSec: 1800, expiresAt: null });
  });

  it("fetches only the Memberstack and Webflow fake hosts; never a Transistor host", async () => {
    const spy = mockAll();
    expect((await play("6ad7b26d1bf051ee351944a3")).status).toBe(200);
    const hosts = spy.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).host);
    expect(hosts.length).toBeGreaterThan(0);
    expect(new Set(hosts)).toEqual(new Set(["localhost:8788"])); // allowlist: the local fake base (wrangler.toml)
  });

  it("an inactive member is 403 membership_inactive", async () => {
    mockAll();
    const res = await play("6ad7b26d1bf051ee351944a3", IDS.inactive);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "membership_inactive" });
  });

  it("a canceled member is 403 membership_inactive", async () => {
    mockAll();
    const res = await play("6ad7b26d1bf051ee351944a3", IDS.canceled);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "membership_inactive" });
  });

  it("401 without a token or with a bad one; checked before anything else", async () => {
    const spy = mockAll();
    expect((await play("6ad7b26d1bf051ee351944a3", null)).status).toBe(401);
    const bad = await play("6ad7b26d1bf051ee351944a3", null, "garbage");
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_token" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unknown class, or one listed in Webflow with unusable audio, is 404 not_found", async () => {
    const base = wfClasses.items[0];
    const bad = ["", "http://media.transistor.fm/a.mp3", "https://share.transistor.fm/s/abc"].map((audio, n) => ({
      ...base, id: `bad${n}`, fieldData: { ...base.fieldData, name: `Bad ${n}`, slug: `bad-${n}`, "audio-file": audio },
    }));
    mockAll({ collections: { "fake-collection": [...wfClasses.items, ...bad], "fake-styles": wfStyles.items, "fake-focus": wfFocus.items, "fake-durations": wfDurations.items } });
    for (const id of ["nope", "constructor", "bad0", "bad1", "bad2"]) {
      const res = await play(id);
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("an inactive member asking for an unknown class is 403 (membership is checked first)", async () => {
    mockAll();
    expect((await play("nope", IDS.inactive)).status).toBe(403);
  });


  it("a malformed class id is 404 not_found, not 500", async () => {
    mockAll();
    const res = await play("%E0%A4");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
