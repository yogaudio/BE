import type { Env } from "./env";
import { ApiError } from "./errors";
import { upstreamFetch } from "./upstream";

// A live CMS item with the WF_FIELD_* slugs already resolved. Values are raw (unknown) until normalizeCatalog.
// `audio` is the raw audio field (a Transistor URL or episode id); Task 4 reads it, the catalog never does.
export interface WebflowItem {
  id: string;
  slug: string;
  title: unknown;
  duration: unknown;
  category: unknown;
  teacher: unknown;
  image: unknown;
  description: unknown;
  audio: unknown;
}
export interface WebflowCategory {
  id: string;
  name: string;
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
// verify in Task 10: response shape against the real Webflow v2 API.
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

export async function loadWebflowItems(env: Env): Promise<WebflowItem[]> {
  return (await fetchLive(env, env.WEBFLOW_COLLECTION_ID)).map((i) => {
    const f = i.fieldData ?? {};
    return {
      id: i.id as string,
      slug: String(f.slug ?? ""),
      title: f[env.WF_FIELD_TITLE],
      duration: f[env.WF_FIELD_DURATION],
      category: f[env.WF_FIELD_CATEGORY],
      teacher: f[env.WF_FIELD_TEACHER],
      image: f[env.WF_FIELD_IMAGE],
      description: f[env.WF_FIELD_DESCRIPTION],
      audio: f[env.WF_FIELD_AUDIO],
    };
  });
}

// Reference fields hold item ids, so names come from the category collection. No collection id = no categories.
export async function loadWebflowCategories(env: Env): Promise<WebflowCategory[]> {
  if (!env.WF_CATEGORY_COLLECTION_ID) return [];
  return (await fetchLive(env, env.WF_CATEGORY_COLLECTION_ID)).flatMap((i) => {
    const name = i.fieldData?.name; // "name" is Webflow's built-in title field on every collection
    return typeof name === "string" && name.trim() ? [{ id: i.id as string, name: name.trim() }] : [];
  });
}
