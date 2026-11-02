import type { Env } from "./env";
import { ApiError } from "./errors";
import { sha256, verifyAccessToken } from "./tokens";
import { F, loadWebflowCollections, type WebflowCollections, type WebflowRawItem } from "./webflow";

const FRESH_MS = 10 * 60_000;
const KEY = "catalog:v2";
const LOCK = "catalog:rebuilding";
const AUDIO_URL = /^https:\/\/media\.transistor\.fm\//;

export interface CatalogClass {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  durationSec: number | null;
  styleIds: string[];
  focusAreaIds: string[];
  durationId: string | null;
}
export interface CatalogOption {
  id: string;
  name: string;
}
export interface CatalogV2 {
  classes: CatalogClass[];
  styles: CatalogOption[];
  focusAreas: CatalogOption[];
  durations: CatalogOption[];
}
export interface ClassAudio {
  url: string;
  durationSec: number | null;
}
// `audio` is the server-side classId -> audio index. It lives only in this KV entry, next to the catalog it was
// built with; only `json` is ever served by /catalog. /play reads `audio`.
type Entry = { version: string; builtAt: number; json: string; audio: Record<string, ClassAudio> };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

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

const refs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : []);
const byName = (a: CatalogOption, b: CatalogOption) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });

// Minutes: the numeric field when positive, else the name as a positive integer, else null.
function minutes(f: Record<string, unknown>): number | null {
  const n = f[F.durationMinutes];
  if (typeof n === "number" && n > 0 && Number.isFinite(n)) return n;
  const name = text(f[F.name]);
  return name && /^\d+$/.test(name) && Number(name) > 0 ? Number(name) : null;
}

// Pure. Only items with a Transistor audio URL and a name become classes; unknown refs are dropped, and an
// option list holds only the options some listed class uses.
export function normalizeCatalog(raw: WebflowCollections): { catalog: CatalogV2; audio: ReadonlyMap<string, ClassAudio> } {
  const names = (items: WebflowRawItem[]) =>
    new Map(items.flatMap((i): [string, string][] => { const n = text(i.fieldData[F.name]); return n ? [[i.id, n]] : []; }));
  const styleNames = names(raw.styles);
  const focusNames = names(raw.focusAreas);
  const durations = new Map(raw.durations.flatMap((i): [string, { name: string; min: number }][] => {
    const name = text(i.fieldData[F.name]), min = minutes(i.fieldData);
    return name && min ? [[i.id, { name, min }]] : [];
  }));
  const usedStyles = new Set<string>(), usedFocus = new Set<string>(), usedDurations = new Set<string>();
  const audio = new Map<string, ClassAudio>();
  const classes = raw.classes.flatMap((i): CatalogClass[] => {
    const f = i.fieldData;
    const title = text(f[F.name]);
    const url = f[F.audio];
    if (!title || typeof url !== "string" || !AUDIO_URL.test(url)) return [];
    const styleIds = refs(f[F.style]).filter((r) => styleNames.has(r));
    const focusAreaIds = refs(f[F.focusAreas]).filter((r) => focusNames.has(r));
    const d = typeof f[F.durations] === "string" ? durations.get(f[F.durations] as string) : undefined;
    const durationSec = d ? Math.round(d.min * 60) : null;
    styleIds.forEach((r) => usedStyles.add(r));
    focusAreaIds.forEach((r) => usedFocus.add(r));
    if (d) usedDurations.add(f[F.durations] as string);
    audio.set(i.id, { url, durationSec });
    return [{ id: i.id, slug: String(f[F.slug] ?? ""), title, description: plainText(f[F.description]), durationSec, styleIds, focusAreaIds, durationId: d ? (f[F.durations] as string) : null }];
  });
  const options = (names: Map<string, string>, used: Set<string>) =>
    [...used].map((id) => ({ id, name: names.get(id)! })).sort(byName);
  return {
    catalog: {
      classes,
      styles: options(styleNames, usedStyles),
      focusAreas: options(focusNames, usedFocus),
      durations: [...usedDurations].sort((a, b) => durations.get(a)!.min - durations.get(b)!.min).map((id) => ({ id, name: durations.get(id)!.name })),
    },
    audio,
  };
}

async function rebuild(env: Env): Promise<Entry> {
  const { catalog, audio } = normalizeCatalog(await loadWebflowCollections(env));
  if (catalog.classes.length === 0) {
    console.warn("catalog rebuild: empty catalog, keeping cached entry");
    throw new ApiError(502, "upstream_unavailable");
  }
  const version = (await sha256(JSON.stringify(catalog))).slice(0, 16);
  const entry: Entry = { version, builtAt: Date.now(), json: JSON.stringify({ version, ...catalog }), audio: Object.fromEntries(audio) };
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
    // stale-while-revalidate; a short KV lock keeps concurrent stale requests from all rebuilding
    // ponytail: KV is eventually consistent, so this cuts the stampede, it does not guarantee one rebuild; rebuilds are idempotent so that is fine
    if (Date.now() - cached.builtAt >= FRESH_MS && !(await env.CACHE.get(LOCK).catch(() => null))) {
      await env.CACHE.put(LOCK, "1", { expirationTtl: 60 }).catch(() => {});
      ctx.waitUntil(
        rebuild(env)
          .catch((e) => console.warn("catalog rebuild failed", e instanceof ApiError ? e.code : "unknown"))
          .finally(() => env.CACHE.delete(LOCK).catch(() => {})),
      );
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
