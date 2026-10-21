// Task 4 rewrites this file for the v2 /play. Kept: the /play paths that still hold and the legacy buildAudioIndex unit test.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAudioIndex } from "../src/audio";
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

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.CACHE.delete("catalog:v2");
  await env.CACHE.delete("ep:ep_fake_1");
  for (const id of Object.values(IDS)) await env.CACHE.delete(`ms:${id}`);
});

describe("GET /play/:classId", () => {
  it("an active member gets the audio-file url and the catalog durationSec; expiresAt is null", async () => {
    mockAll();
    const res = await play("6ad7b26d1bf051ee351944a3");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://media.transistor.fm/00a90e00/36cad4bf.mp3", durationSec: 1800, expiresAt: null });
  });

  it("an inactive member is 403 membership_inactive", async () => {
    mockAll();
    const res = await play("6ad7b26d1bf051ee351944a3", IDS.inactive);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "membership_inactive" });
  });

  it("a past-due member (default statuses) is 403 membership_inactive", async () => {
    mockAll();
    const res = await play("6ad7b26d1bf051ee351944a3", IDS.pastDue);
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

  it("an unknown class is 404 not_found", async () => {
    mockAll();
    for (const id of ["nope", "constructor"]) {
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

const item = (o: Partial<WebflowItem> = {}): WebflowItem => ({
  id: "i1", audio: "https://media.transistor.fm/a.mp3", ...o,
});

describe("buildAudioIndex (legacy, Task 4 removes)", () => {
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
});
