import type { Env } from "./env";
import { ApiError } from "./errors";
import { getCachedEntry, refreshEntry, type Entry } from "./catalog";
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
  // the cached entry as-is (stale is fine); only an unknown id triggers one inline rebuild, unless the entry was just built
  const find = (e: Entry) => { // audio ?? for entries cached before the index existed
    const index = e.audio ?? {};
    return Object.hasOwn(index, classId) ? index[classId] : undefined;
  };
  const { entry, cold } = await getCachedEntry(env);
  const audio = find(entry) ?? (cold ? undefined : find(await refreshEntry(env, entry)));
  if (!audio) throw new ApiError(404, "not_found");
  return Response.json({ url: audio.url, durationSec: audio.durationSec, expiresAt: null }, { headers: { "Cache-Control": "private, no-store" } });
}
