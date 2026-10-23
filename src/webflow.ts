import type { Env } from "./env";
import { ApiError } from "./errors";
import { upstreamFetch } from "./upstream";

// Field slugs of the real Webflow schema (not configurable).
export const F = {
  name: "name",
  slug: "slug",
  audio: "audio-file",
  style: "style",
  focusAreas: "focus-areas",
  durations: "durations",
  description: "description",
  durationMinutes: "duration", // Durations collection: numeric minutes, null on some items
} as const;

// A live CMS item as Webflow returns it; fieldData values stay unknown until normalizeCatalog.
export interface WebflowRawItem {
  id: string;
  fieldData: Record<string, unknown>;
}
export interface WebflowCollections {
  classes: WebflowRawItem[];
  styles: WebflowRawItem[];
  focusAreas: WebflowRawItem[];
  durations: WebflowRawItem[];
}
interface RawItem {
  id?: unknown;
  isDraft?: boolean;
  isArchived?: boolean;
  fieldData?: Record<string, unknown>;
}

const PAGE = 100;
const MAX_PAGES = 50; // ponytail: 5000 items; raise if the library outgrows it

// Every live item of a collection, following `offset` until `pagination.total`. Drafts and archived are skipped.
// verified 2026-10-23: response shape, proven by the live catalog.
async function fetchLive(env: Env, collectionId: string): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
    const res = await upstreamFetch(
      `${env.WEBFLOW_API_BASE}/v2/collections/${encodeURIComponent(collectionId)}/items/live?limit=${PAGE}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${env.WEBFLOW_TOKEN}`, accept: "application/json" } },
    );
    if (!res.ok) throw new ApiError(502, "upstream_unavailable");
    const body = (await res.json().catch(() => null)) as { items?: RawItem[]; pagination?: { total?: number } } | null;
    if (!body || !Array.isArray(body.items)) throw new ApiError(502, "upstream_unavailable");
    out.push(...body.items);
    offset += body.items.length;
    if (body.items.length === 0 || offset >= (body.pagination?.total ?? 0)) break;
  }
  return out.filter((i) => !i.isDraft && !i.isArchived && typeof i.id === "string");
}

// All four collections in parallel. Any failure rejects (502): a catalog with a missing option list would be wrong.
export async function loadWebflowCollections(env: Env): Promise<WebflowCollections> {
  const load = async (id: string) =>
    (await fetchLive(env, id)).map((i): WebflowRawItem => ({ id: i.id as string, fieldData: i.fieldData ?? {} }));
  const [classes, styles, focusAreas, durations] = await Promise.all(
    [env.WEBFLOW_COLLECTION_ID, env.WF_STYLES_COLLECTION_ID, env.WF_FOCUS_COLLECTION_ID, env.WF_DURATIONS_COLLECTION_ID].map(load),
  );
  return { classes, styles, focusAreas, durations };
}
