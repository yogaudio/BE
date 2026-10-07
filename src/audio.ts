import type { Env } from "./env";
import { ApiError } from "./errors";
import { getCatalogEntry } from "./catalog";
import { getMembership } from "./memberstack";
import { verifyAccessToken } from "./tokens";
import { upstreamFetch } from "./upstream";
import type { WebflowItem } from "./webflow";

export interface Audio {
  url: string;
  durationSec: number | null;
}

const EP_TTL = 24 * 3600;
const MEDIA_HOST = "media.transistor.fm";

// Where a raw audio field points: a direct media URL (used as is), or an episode id (also taken from a share URL).
function parseRef(raw: unknown): { url: string } | { episodeId: string } | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (/^[\w-]+$/.test(s)) return { episodeId: s };
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    if (u.hostname === MEDIA_HOST) return { url: s };
    // verify in Task 10: that the last segment of a share URL is accepted by GET /v1/episodes/:id
    const last = u.hostname === "share.transistor.fm" ? u.pathname.split("/").filter(Boolean).pop() : undefined;
    return last && /^[\w-]+$/.test(last) ? { episodeId: last } : null;
  } catch {
    return null;
  }
}

// Episode lookup, cached in KV for 24 h. null = the episode does not exist or has no usable media URL (bad CMS data);
// a Transistor outage throws 502 (upstreamFetch), so it is never cached or mistaken for bad data.
// verify in Task 10: response shape against the real Transistor API.
async function lookupEpisode(env: Env, id: string): Promise<Audio | null> {
  const key = `ep:${id}`;
  const hit = await env.CACHE.get<Audio>(key, "json").catch(() => null);
  if (hit) return hit;
  const res = await upstreamFetch(`${env.TRANSISTOR_API_BASE}/v1/episodes/${encodeURIComponent(id)}`, {
    headers: { "x-api-key": env.TRANSISTOR_API_KEY, accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(502, "upstream_unavailable");
  const a = ((await res.json().catch(() => null)) as { data?: { attributes?: { media_url?: unknown; duration?: unknown } } } | null)?.data?.attributes;
  if (typeof a?.media_url !== "string" || !a.media_url.startsWith("https://")) return null;
  const audio: Audio = { url: a.media_url, durationSec: typeof a.duration === "number" && a.duration > 0 ? Math.round(a.duration) : null };
  await env.CACHE.put(key, JSON.stringify(audio), { expirationTtl: EP_TTL }).catch(() => {});
  return audio;
}

// classId -> audio for every item that has playable audio. Items with no/unusable audio are simply absent.
// A Transistor outage fails the whole build (502): the catalog keeps serving its stale cache instead of
// silently losing classes until the next rebuild.
export async function buildAudioIndex(env: Env, items: WebflowItem[]): Promise<Map<string, Audio>> {
  const out = new Map<string, Audio>();
  await Promise.all(
    items.map(async (i) => {
      const ref = parseRef(i.audio);
      const audio = !ref ? null : "url" in ref ? { url: ref.url, durationSec: null } : await lookupEpisode(env, ref.episodeId);
      if (audio) out.set(i.id, audio);
    }),
  );
  return out;
}

export async function getPlay(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const memberId = await verifyAccessToken(env, request.headers.get("Authorization"));
  if (!(await getMembership(env, ctx, memberId)).active) throw new ApiError(403, "membership_inactive");
  const classId = decodeURIComponent(new URL(request.url).pathname.split("/")[2] ?? "");
  const index = (await getCatalogEntry(env, ctx)).audio ?? {}; // ?? for entries cached before the index existed
  const audio = Object.hasOwn(index, classId) ? index[classId] : undefined;
  if (!audio) throw new ApiError(404, "not_found");
  return Response.json({ url: audio.url, durationSec: audio.durationSec, expiresAt: null }, { headers: { "Cache-Control": "private, no-store" } });
}
