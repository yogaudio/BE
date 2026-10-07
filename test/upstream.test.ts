import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors";
import { upstreamFetch } from "../src/upstream";

afterEach(() => vi.restoreAllMocks());
const mockFetch = (impl: typeof fetch) => vi.spyOn(globalThis, "fetch").mockImplementation(impl);
const is502 = (e: unknown) => e instanceof ApiError && e.status === 502 && e.code === "upstream_unavailable";

describe("upstreamFetch", () => {
  it("network error becomes 502", async () => {
    mockFetch(async () => { throw new TypeError("fetch failed"); });
    await expect(upstreamFetch("http://x.test")).rejects.toSatisfy(is502);
  });

  it("timeout becomes 502", async () => {
    mockFetch((_u, init) => new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason))));
    await expect(upstreamFetch("http://x.test", {}, 20)).rejects.toSatisfy(is502);
  });

  it("upstream 5xx becomes 502", async () => {
    mockFetch(async () => new Response("boom", { status: 503 }));
    await expect(upstreamFetch("http://x.test")).rejects.toSatisfy(is502);
  });

  it("2xx and 4xx pass through", async () => {
    mockFetch(async () => new Response("ok"));
    expect((await upstreamFetch("http://x.test")).status).toBe(200);
    mockFetch(async () => new Response("no", { status: 401 }));
    expect((await upstreamFetch("http://x.test")).status).toBe(401);
  });
});
