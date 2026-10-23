// Drives the fake /app-login (real v2 embed + stub Memberstack) in headless Chrome over CDP.
// Needs `npm run dev` (:8787) and `npm run fakes` (:8788) running. Node built-ins only.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = "http://localhost:8788/app-login";
const WORKER = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => b.toString("base64url");

const port = await new Promise((res) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const dir = mkdtempSync(join(tmpdir(), "check-login-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const cleanup = () => { chrome.kill("SIGKILL"); try { rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on("SIGINT", () => { cleanup(); process.exit(130); });

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); if (!ok) failed++; };

try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("CDP connect failed")); });
  let id = 0, navs = [];
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === "Page.frameRequestedNavigation") navs.push(d.params.url);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send("Page.enable");
  await send("Runtime.enable");

  const open = async (url) => { navs = []; await send("Page.navigate", { url }); await sleep(300); };
  const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
  // Native value setter + input event, so the form sees the values like typed input.
  const fill = (email, password) => ev(`(() => { for (const [i, v] of [["app-login-email", ${JSON.stringify(email)}], ["app-login-password", ${JSON.stringify(password)}]]) { const el = document.getElementById(i); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); } document.getElementById("app-login-submit").click(); })()`);
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const query = (c) => `?state=${b64u(randomBytes(15))}&code_challenge=${c}`;
  const formVisible = "!!document.getElementById('app-login-form') && document.querySelector('[data-app-own-form]').style.display !== 'none'";

  // Case A: good login hands off and the code exchanges for tokens.
  await open(PAGE + query(challenge));
  check("A form shows", await waitFor(formVisible));
  await fill("active@fake.test", "anything");
  const gotNav = await (async () => { for (let t = 0; t < 8000; t += 100) { if (navs.some((u) => u.startsWith("yogaudio://auth?code="))) return true; await sleep(100); } return false; })();
  const nav = navs.find((u) => u.startsWith("yogaudio://auth?code="));
  check("A navigation to yogaudio://auth?code=", gotNav, nav ? nav.replace(/code=[^&]+/, "code=<redacted>") : `navs=${JSON.stringify(navs)}`);
  if (nav) {
    const code = new URL(nav).searchParams.get("code");
    const r = await fetch(`${WORKER}/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, codeVerifier: verifier }) });
    const j = await r.json().catch(() => ({}));
    check("A /auth/exchange 200 with tokens", r.status === 200 && !!j.accessToken && !!j.refreshToken, `status ${r.status}, active=${j.active}`);
  }

  // Case B: wrong password shows the fixed copy and does not navigate.
  await open(PAGE + query(challenge));
  await waitFor(formVisible);
  await fill("active@fake.test", "wrong");
  const errOk = await waitFor("document.getElementById('app-login-error').textContent === 'Email or password is incorrect.'");
  await sleep(2000); // past the embed's 1.5 s return-link timer
  check("B fixed error copy", errOk, await ev("document.getElementById('app-login-error').textContent"));
  check("B no navigation", !navs.some((u) => u.startsWith("yogaudio://")) && !(await ev("!!document.getElementById('app-login-return')")), JSON.stringify(navs.filter((u) => u.startsWith("yogaudio://"))));

  // Case C: no query shows the invalid-link message.
  await open(PAGE);
  const cOk = await waitFor("document.getElementById('app-login-msg').textContent.includes('not valid')");
  check("C not-valid message, no form", cOk && !(await ev(formVisible)), await ev("document.getElementById('app-login-msg').textContent"));
  ws.close();
} catch (e) {
  console.log("FAIL " + e.message);
  failed++;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
