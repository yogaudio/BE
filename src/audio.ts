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
const EP_JITTER = 6 * 3600; // +-, so the ep: keys do not all expire on the same day-tick
const MAX_LOOKUPS = 4; // concurrent Transistor calls: small rate limit, Workers subrequest cap
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
  // Other 4xx (400/403/404/422...) mean this one episode id is bad CMS data: no audio for the item.
  // 401 (our key is wrong), 408, 429 and anything else non-ok are transient: fail the build, keep the stale cache.
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status)) return null;
    throw new ApiError(502, "upstream_unavailable");
  }
  const a = ((await res.json().catch(() => null)) as { data?: { attributes?: { media_url?: unknown; duration?: unknown } } } | null)?.data?.attributes;
  if (typeof a?.media_url !== "string" || !a.media_url.startsWith("https://")) return null;
  const audio: Audio = { url: a.media_url, durationSec: typeof a.duration === "number" && a.duration > 0 ? Math.round(a.duration) : null };
  await env.CACHE.put(key, JSON.stringify(audio), { expirationTtl: Math.round(EP_TTL + (Math.random() * 2 - 1) * EP_JITTER) }).catch(() => {});
  return audio;
}

// classId -> audio for every item that has playable audio. Items with no/unusable audio are simply absent.
// A Transistor outage fails the whole build (502): the catalog keeps serving its stale cache instead of
// silently losing classes until the next rebuild.
export async function buildAudioIndex(env: Env, items: WebflowItem[]): Promise<Map<string, Audio>> {
  const out = new Map<string, Audio>();
  const queue = [...items];
  const worker = async () => {
    for (let i = queue.shift(); i; i = queue.shift()) {
      const ref = parseRef(i.audio);
      const audio = !ref ? null : "url" in ref ? { url: ref.url, durationSec: null } : await lookupEpisode(env, ref.episodeId);
      if (audio) out.set(i.id, audio);
      else if (ref) console.warn("audio: no usable audio for item", i.id);
    }
  };
  await Promise.all(Array.from({ length: MAX_LOOKUPS }, worker)); // tiny pool; a rejection fails the build
  return out;
}

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
