import { ApiError } from "./errors";

// Every upstream call goes through here: timeout, and network errors / timeouts / 5xx all
// become ApiError(502, "upstream_unavailable"). 4xx and 2xx pass through for the caller to judge.
export async function upstreamFetch(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ApiError(502, "upstream_unavailable");
  }
  if (res.status >= 500) {
    console.warn("upstream: status", res.status, new URL(url).hostname);
    throw new ApiError(502, "upstream_unavailable");
  }
  return res;
}
