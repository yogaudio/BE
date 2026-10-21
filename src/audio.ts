import type { Env } from "./env";
import { ApiError } from "./errors";
import { getCatalogEntry } from "./catalog";
import { getMembership } from "./memberstack";
import { verifyAccessToken } from "./tokens";

export async function getPlay(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const memberId = await verifyAccessToken(env, request.headers.get("Authorization"));
  if (!(await getMembership(env, ctx, memberId)).active) throw new ApiError(403, "membership_inactive");
  let classId: string;
  try {
    classId = decodeURIComponent(new URL(request.url).pathname.split("/")[2] ?? "");
  } catch {
    throw new ApiError(404, "not_found"); // malformed %-escape
  }
  const index = (await getCatalogEntry(env, ctx)).audio ?? {}; // ?? for entries cached before the index existed
  const audio = Object.hasOwn(index, classId) ? index[classId] : undefined;
  if (!audio) throw new ApiError(404, "not_found");
  return Response.json({ url: audio.url, durationSec: audio.durationSec, expiresAt: null }, { headers: { "Cache-Control": "private, no-store" } });
}
