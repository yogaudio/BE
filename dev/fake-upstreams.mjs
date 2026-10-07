// Fake Memberstack, Webflow, Transistor and the yogaudio.com login page, for local dev. Node built-ins only.
// Run: node dev/fake-upstreams.mjs   (port 8788)
// Faults: FAKE_FAULT=slow|500|drop env var, `?fault=` on any request, or at runtime
//   GET /_fault?mode=slow|500|drop|off[&service=memberstack|webflow|transistor]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 8788);
const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";
const KEYS = {
  memberstack: process.env.MEMBERSTACK_SECRET_KEY ?? "sk_fake_memberstack",
  webflow: process.env.WEBFLOW_TOKEN ?? "fake-webflow-token",
  transistor: process.env.TRANSISTOR_API_KEY ?? "fake-transistor-key",
};
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const members = fixture("members.json");
const webflow = fixture("webflow-items.json");
const episodes = fixture("transistor-episodes.json");

let faultAll = process.env.FAKE_FAULT || "off";
const faultBy = {};

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// Returns true if the request was consumed by a fault.
async function applyFault(service, url, req, res) {
  const mode = url.searchParams.get("fault") ?? req.headers["x-fake-fault"] ?? faultBy[service] ?? faultAll;
  if (mode === "slow") await new Promise((r) => setTimeout(r, 5000));
  if (mode === "500") return send(res, 500, { message: "fake upstream failure" }), true;
  if (mode === "drop") return req.socket.destroy(), true;
  return false;
}

// The fake page runs the real embed's handoff script (login-page/app-login.html, one source of truth);
// only the token source is swapped: the two buttons stand in for Memberstack's login.
const embed = () => readFileSync(new URL("../login-page/app-login.html", import.meta.url), "utf8");
const handoffScript = () => {
  const m = embed().match(/<script id="handoff">[\s\S]*?<\/script>/);
  if (!m) throw new Error('login-page/app-login.html has no <script id="handoff"> block; the fake /app-login needs it');
  return m[0];
};
const loginPage = () => `<!doctype html><meta charset="utf-8"><title>Fake app login</title>
<h1>Fake yogaudio.com /app-login</h1>
<p id="app-login-msg"></p>
<div data-app-login-form>
<button data-t="fake-ms-token-active">Sign in as active member</button>
<button data-t="fake-ms-token-inactive">Sign in as inactive member</button>
</div>
<script>window.YOGAUDIO_CODE_URL = ${JSON.stringify(WORKER_URL + "/auth/code")};
let cb;
window.YOGAUDIO_TOKEN_SOURCE = { getToken: async () => null, onLogin: (f) => { cb = f; } };
for (const b of document.querySelectorAll("button")) b.onclick = () => cb(b.dataset.t);</script>
${handoffScript()}`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const auth = (service, ok) => ok || (send(res, 401, { message: "invalid api key" }), false);

  if (p === "/_fault") {
    const mode = url.searchParams.get("mode") ?? "off";
    const service = url.searchParams.get("service");
    if (service) faultBy[service] = mode === "off" ? undefined : mode;
    else { faultAll = mode; for (const k in faultBy) delete faultBy[k]; }
    return send(res, 200, { faultAll, faultBy });
  }

  if (p === "/app-login") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(loginPage());
  }

  // Memberstack Admin API. https://developers.memberstack.com/admin-rest-api/members
  if (p.startsWith("/memberstack/")) {
    if (await applyFault("memberstack", url, req, res)) return;
    if (!auth("memberstack", req.headers["x-api-key"] === KEYS.memberstack)) return;
    // POST /members/verify-token  https://developers.memberstack.com/admin-rest-api/verify-token
    if (req.method === "POST" && p === "/memberstack/members/verify-token") {
      let raw = "";
      for await (const c of req) raw += c;
      let token;
      try { token = JSON.parse(raw).token; } catch { return send(res, 400, { message: "bad json" }); }
      const m = members[token];
      if (!m) return send(res, 401, { message: "invalid token" });
      const now = Math.floor(Date.now() / 1000);
      return send(res, 200, { data: { id: m.id, type: "member", iat: now, exp: now + 3600, aud: "app_fake", iss: "https://api.memberstack.io" } });
    }
    // GET /members/:id  https://developers.memberstack.com/admin-rest-api/members#get-member
    const mm = p.match(/^\/memberstack\/members\/([^/]+)$/);
    if (req.method === "GET" && mm) {
      const m = Object.values(members).find((x) => x.id === mm[1]);
      return m ? send(res, 200, { data: m }) : send(res, 404, { message: "member not found" });
    }
  }

  // Webflow Data API v2. https://developers.webflow.com/data/reference/cms/collection-items/live-items/list-items-live
  const wf = p.match(/^\/webflow\/v2\/collections\/([^/]+)\/items\/live$/);
  if (wf && req.method === "GET") {
    if (await applyFault("webflow", url, req, res)) return;
    if (!auth("webflow", req.headers.authorization === `Bearer ${KEYS.webflow}`)) return;
    // the item collection and the category collection are separate, as in a real Webflow site
    const all = { "fake-collection": webflow.items, [webflow.categoryCollection]: webflow.categories }[wf[1]];
    if (!all) return send(res, 404, { message: "collection not found" });
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    // note: real "live" listing omits drafts; fixtures keep them so tests exercise the isDraft/isArchived flags
    const items = all.slice(offset, offset + limit).map((i) => ({
      cmsLocaleId: "loc_fake", lastPublished: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", createdOn: "2026-01-01T00:00:00.000Z", ...i,
    }));
    return send(res, 200, { items, pagination: { limit, offset, total: all.length } });
  }

  // Transistor API v1. https://developers.transistor.fm/#get-/v1/episodes/-id-
  const tr = p.match(/^\/transistor\/v1\/episodes\/([^/]+)$/);
  if (tr && req.method === "GET") {
    if (await applyFault("transistor", url, req, res)) return;
    if (!auth("transistor", req.headers["x-api-key"] === KEYS.transistor)) return;
    return episodes[tr[1]] ? send(res, 200, { data: episodes[tr[1]] }) : send(res, 404, { message: "not found" });
  }

  send(res, 404, { message: "not found" });
}).listen(PORT, () => console.log(`fake upstreams on http://localhost:${PORT}`));
