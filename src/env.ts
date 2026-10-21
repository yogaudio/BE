export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;

  // vars (wrangler.toml)
  LOGIN_PAGE_ORIGIN: string;
  ACTIVE_PLAN_STATUSES: string;
  ALLOWED_PLAN_IDS: string;
  MEMBERSTACK_API_BASE: string;
  WEBFLOW_API_BASE: string;
  TRANSISTOR_API_BASE: string;
  STRIPE_API_BASE: string;
  WEBFLOW_COLLECTION_ID: string;
  WF_STYLES_COLLECTION_ID: string;
  WF_FOCUS_COLLECTION_ID: string;
  WF_DURATIONS_COLLECTION_ID: string;
  WF_FIELD_AUDIO: string; // Task 4 removes it with audio.ts's Transistor lookups

  // secrets (wrangler secret / .dev.vars)
  MEMBERSTACK_SECRET_KEY: string;
  WEBFLOW_TOKEN: string;
  TRANSISTOR_API_KEY: string;
  STRIPE_RESTRICTED_KEY: string;
  TOKEN_SIGNING_KEY: string;
}
