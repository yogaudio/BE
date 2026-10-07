// Handlers throw this; the router turns it into `{ "error": code }` with the status.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const jsonError = (status: number, code: string, headers?: HeadersInit) =>
  Response.json({ error: code }, { status, headers });
