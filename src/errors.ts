export type ErrorCode =
  | "invalid_request"
  | "invalid_token"
  | "invalid_grant"
  | "membership_inactive"
  | "not_found"
  | "upstream_unavailable"
  | "internal";

// Handlers throw this; the router turns it into `{ "error": code }` with the status.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
  ) {
    super(code);
  }
}

export const jsonError = (status: number, code: ErrorCode, headers?: HeadersInit) =>
  Response.json({ error: code }, { status, headers });
