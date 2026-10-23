// Fake Memberstack, Stripe, Webflow and the yogaudio.com login page, for local dev. Node built-ins only.
// Run: node dev/fake-upstreams.mjs   (port 8788)
// Faults: FAKE_FAULT=slow|500|drop env var, `?fault=` on any request, or at runtime
//   GET /_fault?mode=slow|500|drop|off[&service=memberstack|stripe|webflow]
// State (deleted members, cancelled subscriptions) lives for the process; GET /_reset restores it.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 8788);
const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";
const KEYS = {
  memberstack: process.env.MEMBERSTACK_SECRET_KEY ?? "sk_fake_memberstack",
  webflow: process.env.WEBFLOW_TOKEN ?? "fake-webflow-token",
  stripe: process.env.STRIPE_RESTRICTED_KEY ?? "rk_fake_stripe",
};
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const members = fixture("members.json");
// Collection id (the top-level wrangler.toml vars) -> full Webflow v2 items/live response saved from the real site.
const webflow = {
  "fake-collection": fixture("webflow-classes.json"),
  "fake-styles": fixture("webflow-styles.json"),
  "fake-focus": fixture("webflow-focus-areas.json"),
  "fake-durations": fixture("webflow-durations.json"),
};
const subsFixture = fixture("stripe-subscriptions.json");
let subs = structuredClone(subsFixture);
const deleted = new Set();

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

// The fake page serves the whole real embed (login-page/app-login.html, one source of truth) after a stub
// window.$memberstackDom that implements only what the embed calls. The email picks the fake token.
// Serve-time rewrite: only the YOGAUDIO_CODE_URL constant (production worker) is pointed at the local worker.
const FAKE_LOGINS = {
  "active@fake.test": "fake-ms-token-active",
  "noplan@fake.test": "fake-ms-token-noplan",
  "canceled@fake.test": "fake-ms-token-canceled",
  "requires-payment@fake.test": "fake-ms-token-requires-payment",
};
const loginPage = () => {
  const html = readFileSync(new URL("../login-page/app-login.html", import.meta.url), "utf8");
  const re = /window\.YOGAUDIO_CODE_URL = "[^"]*";/;
  if (!re.test(html)) throw new Error("login-page/app-login.html has no window.YOGAUDIO_CODE_URL constant; the fake /app-login needs it");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake app login</title>
<h1>Fake yogaudio.com /app-login</h1>
<p>Fake page, local dev only. Log in with any password (<code>wrong</code> fails) and one of: ${Object.keys(FAKE_LOGINS).map((e) => `<code>${e}</code>`).join(", ")}.</p>
<script>
const logins = ${JSON.stringify(FAKE_LOGINS)};
window.$memberstackDom = {
  getCurrentMember: async () => ({ data: null }),
  getMemberCookie: () => null,
  sendMemberResetPasswordEmail: async () => ({}),
  loginMemberEmailPassword: async ({ email, password }) => {
    const t = logins[email];
    if (!t || password === "wrong") throw Object.assign(new Error("Invalid email or password"), { code: "invalid-credentials" });
    return { data: { member: { id: "fake-" + t }, tokens: { accessToken: t } } };
  },
};
</script>
${html.replace(re, () => `window.YOGAUDIO_CODE_URL = ${JSON.stringify(WORKER_URL + "/auth/code")};`)}`;
};

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

  if (p === "/_reset") {
    subs = structuredClone(subsFixture);
    deleted.clear();
    return send(res, 200, { reset: true });
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
      if (!m || deleted.has(m.id)) return send(res, 401, { message: "invalid token" });
      const now = Math.floor(Date.now() / 1000);
      return send(res, 200, { data: { id: m.id, type: "member", iat: now, exp: now + 3600, aud: "app_fake", iss: "https://api.memberstack.io" } });
    }
    // GET /members/:id  https://developers.memberstack.com/admin-rest-api/members#get-member
    const mm = p.match(/^\/memberstack\/members\/([^/]+)$/);
    if (req.method === "GET" && mm) {
      const m = Object.values(members).find((x) => x.id === mm[1]);
      return m && !deleted.has(m.id) ? send(res, 200, { data: m }) : send(res, 404, { message: "member not found" });
    }
    // DELETE /members/:id  https://developers.memberstack.com/admin-rest-api/members#delete-member
    if (req.method === "DELETE" && mm) {
      const m = Object.values(members).find((x) => x.id === mm[1]);
      if (!m || deleted.has(m.id)) return send(res, 404, { message: "member not found" });
      deleted.add(m.id);
      res.writeHead(204);
      return res.end();
    }
  }

  // Stripe API (restricted key). https://docs.stripe.com/api/subscriptions
  if (p.startsWith("/stripe/")) {
    if (await applyFault("stripe", url, req, res)) return;
    if (!auth("stripe", req.headers.authorization === `Bearer ${KEYS.stripe}`)) return;
    if (req.method === "GET" && p === "/stripe/v1/subscriptions") {
      const list = subs[url.searchParams.get("customer")];
      return list ? send(res, 200, { object: "list", data: list, has_more: false }) : send(res, 404, { error: { message: "No such customer" } });
    }
    const sm = p.match(/^\/stripe\/v1\/subscriptions\/([^/]+)$/);
    if (req.method === "DELETE" && sm) {
      const sub = Object.values(subs).flat().find((x) => x.id === sm[1]);
      if (!sub) return send(res, 404, { error: { message: "No such subscription" } });
      sub.status = "canceled";
      return send(res, 200, sub);
    }
  }

  // Webflow Data API v2. https://developers.webflow.com/data/reference/cms/collection-items/live-items/list-items-live
  const wf = p.match(/^\/webflow\/v2\/collections\/([^/]+)\/items\/live$/);
  if (wf && req.method === "GET") {
    if (await applyFault("webflow", url, req, res)) return;
    if (!auth("webflow", req.headers.authorization === `Bearer ${KEYS.webflow}`)) return;
    const all = webflow[wf[1]]?.items;
    if (!all) return send(res, 404, { message: "collection not found" });
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const items = all.slice(offset, offset + limit);
    return send(res, 200, { items, pagination: { limit, offset, total: all.length } });
  }

  send(res, 404, { message: "not found" });
}).listen(PORT, () => console.log(`fake upstreams on http://localhost:${PORT}`));
