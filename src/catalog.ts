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
type Entry = { version: string; builtAt: number; json: string };

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

// Rich-text HTML to plain text. A description that leaks a Transistor link is dropped entirely.
function plainText(v: unknown): string | null {
  if (typeof v !== "string" || /transistor\.fm/i.test(v)) return null; // checked on the raw HTML, so an href counts too
  const t = text(
    typeof v === "string"
      ? v.replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e as string]!).replace(/\s+/g, " ")
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

// Pure. `audioIndex` (Task 4): item ids that have playable audio; when given, other items are dropped.
// Without it nothing is dropped for missing audio. The raw audio field never reaches the output.
export function normalizeCatalog(
  items: WebflowItem[],
  audioIndex?: ReadonlySet<string>,
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
      durationSec: parseDuration(i.duration),
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
  const body = normalizeCatalog(items, undefined, categories);
  const version = (await sha256(JSON.stringify(body))).slice(0, 16);
  const entry: Entry = { version, builtAt: Date.now(), json: JSON.stringify({ version, ...body }) };
  await env.CACHE.put(KEY, JSON.stringify(entry)).catch(() => {});
  return entry;
}

const etagMatches = (header: string | null, version: string) =>
  (header ?? "").split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    return v === version || t.trim() === "*";
  });

export async function getCatalog(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await verifyAccessToken(env, request.headers.get("Authorization"));
  const cached = await env.CACHE.get<Entry>(KEY, "json").catch(() => null);
  let entry: Entry;
  if (cached) {
    entry = cached;
    // stale-while-revalidate; concurrent rebuilds are harmless (last write wins)
    if (Date.now() - cached.builtAt >= FRESH_MS) {
      ctx.waitUntil(rebuild(env).catch((e) => console.warn("catalog rebuild failed", e instanceof ApiError ? e.code : "unknown")));
    }
  } else {
    entry = await rebuild(env);
  }
  const headers = { ETag: `"${entry.version}"`, "Cache-Control": "private, no-cache" };
  if (etagMatches(request.headers.get("If-None-Match"), entry.version)) return new Response(null, { status: 304, headers });
  return new Response(entry.json, { headers: { ...headers, "content-type": "application/json" } });
}
