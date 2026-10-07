import { buildAudioIndex, type Audio } from "./audio";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { sha256, verifyAccessToken } from "./tokens";
import { loadWebflowCategories, loadWebflowItems, type WebflowCategory, type WebflowItem } from "./webflow";

const FRESH_MS = 10 * 60_000;
const KEY = "catalog:v1";

export interface CatalogClass {
  id: string;
  slug: string;
  title: string;
  durationSec: number | null;
  categoryIds: string[];
  teacher: string | null;
  artworkUrl: string | null;
  description: string | null;
}
export interface CatalogBody {
  classes: CatalogClass[];
  categories: WebflowCategory[];
}
export type Catalog = CatalogBody & { version: string };
// `audio` is the server-side classId -> audio index. It lives only in this KV entry, next to the catalog it was
// built with; only `json` is ever served by /catalog. /play reads `audio`.
type Entry = { version: string; builtAt: number; json: string; audio: Record<string, Audio> };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// Seconds as a number, "mm:ss" or "hh:mm:ss"; anything else is null.
function parseDuration(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && Math.round(v) > 0 ? Math.round(v) : null;
  const m = typeof v === "string" ? v.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/) : null;
  if (!m) return null;
  const [h, min, s] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (s > 59 || (m[1] !== undefined && min > 59)) return null;
  const total = h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
// One pass, so "&amp;#8217;" stays "&#8217;". An out-of-range code point is left as written.
function decodeEntity(all: string, named?: string, dec?: string, hex?: string): string {
  if (named) return NAMED[named]!;
  const cp = dec ? Number(dec) : parseInt(hex!, 16);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
}

// Rich-text HTML to plain text. A description that leaks a Transistor link is dropped entirely.
function plainText(v: unknown): string | null {
  if (typeof v !== "string" || /transistor\.fm/i.test(v)) return null; // checked on the raw HTML, so an href counts too
  const t = text(
    typeof v === "string"
      ? v.replace(/<[^>]*>/g, " ").replace(/&(?:(amp|lt|gt|quot|#39|nbsp)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g, decodeEntity).replace(/\s+/g, " ")
      : null,
  );
  return t;
}

function httpsUrl(v: unknown): string | null {
  const s = text(typeof v === "object" && v !== null ? (v as { url?: unknown }).url : v);
  try {
    return s && new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

// Pure. `audioIndex`: when given, classes absent from it are dropped and a missing duration is filled from it.
// Without it nothing is dropped for missing audio. Audio never reaches the output.
export function normalizeCatalog(
  items: WebflowItem[],
  audioIndex?: ReadonlyMap<string, Audio>,
  categories: WebflowCategory[] = [],
): CatalogBody {
  const known = new Set(categories.map((c) => c.id));
  const classes = items.flatMap((i): CatalogClass[] => {
    const title = text(i.title);
    if (!i.id || !title || (audioIndex && !audioIndex.has(i.id))) return [];
    const refs = Array.isArray(i.category) ? i.category : [i.category];
    return [{
      id: i.id,
      slug: i.slug,
      title,
      durationSec: parseDuration(i.duration) ?? audioIndex?.get(i.id)?.durationSec ?? null,
      categoryIds: refs.filter((r): r is string => typeof r === "string" && known.has(r)),
      teacher: text(i.teacher),
      artworkUrl: httpsUrl(i.image),
      description: plainText(i.description),
    }];
  });
  return { classes, categories };
}

async function rebuild(env: Env): Promise<Entry> {
  const [items, categories] = await Promise.all([loadWebflowItems(env), loadWebflowCategories(env)]);
  const index = await buildAudioIndex(env, items); // throws on a Transistor outage: the stale cache stays
  const body = normalizeCatalog(items, index, categories);
  const version = (await sha256(JSON.stringify(body))).slice(0, 16);
  const entry: Entry = { version, builtAt: Date.now(), json: JSON.stringify({ version, ...body }),
    audio: Object.fromEntries(body.classes.map((c) => [c.id, index.get(c.id)!])),
  };
  await env.CACHE.put(KEY, JSON.stringify(entry)).catch(() => {});
  return entry;
}

const etagMatches = (header: string | null, version: string) =>
  (header ?? "").split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    return v === version || t.trim() === "*";
  });

// The cached entry (building it when empty). Stale entries are served while a rebuild runs via waitUntil.
export async function getCatalogEntry(env: Env, ctx: ExecutionContext): Promise<Entry> {
  const cached = await env.CACHE.get<Entry>(KEY, "json").catch(() => null);
  if (cached) {
    // stale-while-revalidate; concurrent rebuilds are harmless (last write wins)
    if (Date.now() - cached.builtAt >= FRESH_MS) {
      ctx.waitUntil(rebuild(env).catch((e) => console.warn("catalog rebuild failed", e instanceof ApiError ? e.code : "unknown")));
    }
    return cached;
  }
  return rebuild(env);
}

export async function getCatalog(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await verifyAccessToken(env, request.headers.get("Authorization"));
  const entry = await getCatalogEntry(env, ctx);
  const headers = { ETag: `"${entry.version}"`, "Cache-Control": "private, no-cache" };
  if (etagMatches(request.headers.get("If-None-Match"), entry.version)) return new Response(null, { status: 304, headers });
  return new Response(entry.json, { headers: { ...headers, "content-type": "application/json" } });
}
