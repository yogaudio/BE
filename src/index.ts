import type { Env } from "./env";
import { ApiError, jsonError } from "./errors";
import { authCode, authExchange, authLogout, authRefresh } from "./auth";
import { getPlay } from "./audio";
import { getCatalog } from "./catalog";
import { deleteAccount } from "./account";

export type { Env } from "./env";

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

// Later tasks register their handlers here, keyed by "METHOD /path".
export const routes: Record<string, Handler> = {
  "GET /health": () => new Response("ok"),
  "POST /auth/code": authCode,
  "POST /auth/exchange": authExchange,
  "POST /auth/refresh": authRefresh,
  "POST /auth/logout": authLogout,
  "POST /account/delete": deleteAccount,
  "GET /catalog": getCatalog,
  "GET /play/:classId": getPlay,
};

// CORS is for the login page's POST /auth/code only; every other route sends none.
const CORS_PATH = "/auth/code";

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== env.LOGIN_PAGE_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (request.method === "OPTIONS" && pathname === CORS_PATH) {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    const handler = routes[`${request.method} ${pathname.replace(/^(\/play)\/[^/]+$/, "$1/:classId")}`];
    if (!handler) return jsonError(404, "not_found");
    const res = await handler(request, env, ctx);
    if (pathname !== CORS_PATH) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) out.headers.set(k, v);
    return out;
  } catch (e) {
    const extra = pathname === CORS_PATH ? corsHeaders(request, env) : undefined;
    if (e instanceof ApiError) return jsonError(e.status, e.code, extra);
    console.error("unhandled", e instanceof Error ? e.message : "unknown");
    return jsonError(500, "internal", extra);
  }
}

export default {
  fetch: route,
} satisfies ExportedHandler<Env>;
