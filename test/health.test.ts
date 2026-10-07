import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("router", () => {
  it("GET /health returns 200", async () => {
    const res = await SELF.fetch("https://api.test/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("unknown path returns 404 not_found JSON", async () => {
    const res = await SELF.fetch("https://api.test/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("preflight for /auth/code from the allowed origin gets CORS headers", async () => {
    const res = await SELF.fetch("https://api.test/auth/code", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8788",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8788");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("content-type");
  });

  it("preflight from another origin gets no CORS headers", async () => {
    const res = await SELF.fetch("https://api.test/auth/code", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("other routes send no CORS headers", async () => {
    const res = await SELF.fetch("https://api.test/health", { headers: { Origin: "http://localhost:8788" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
