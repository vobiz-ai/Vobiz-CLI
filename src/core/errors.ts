/**
 * Error categories the CLI reports. Mirrors the Vobiz MCP server's model so scripts and agents see one
 * vocabulary across tools. Raw backend bodies, headers and stack traces are never printed without --verbose.
 */
export type ErrorKind =
  | "invalid_input"
  | "missing_credentials"
  | "auth_failed"
  | "forbidden"
  | "insufficient_balance"
  | "not_found"
  | "account_suspended"
  | "rate_limited"
  | "service_unavailable"
  | "backend_error"
  | "timeout"
  | "network_error"
  | "outcome_unknown"
  | "unexpected_response"
  | "confirmation_required"
  | "not_allowed"
  | "unsupported"
  | "internal_error";

/** Process exit codes. Stable: scripts may branch on them. */
export const EXIT: Record<ErrorKind, number> & { ok: number; usage: number } = {
  ok: 0,
  internal_error: 1,
  backend_error: 1,
  unexpected_response: 1,
  service_unavailable: 1,
  usage: 2,
  invalid_input: 2,
  unsupported: 2,
  missing_credentials: 3,
  auth_failed: 3,
  forbidden: 3,
  account_suspended: 3,
  not_found: 4,
  rate_limited: 5,
  insufficient_balance: 5,
  confirmation_required: 6,
  not_allowed: 6,
  outcome_unknown: 7,
  timeout: 8,
  network_error: 8,
};

const RETRYABLE = new Set<ErrorKind>(["rate_limited", "service_unavailable", "backend_error", "timeout", "network_error"]);
export const isRetryable = (kind: ErrorKind): boolean => RETRYABLE.has(kind);

export class VobizError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "VobizError";
  }
  get exitCode(): number {
    return EXIT[this.kind] ?? 1;
  }
  toJSON() {
    return { error: this.kind, message: this.message, status: this.status, retryable: isRetryable(this.kind) };
  }
}

export function kindForStatus(status: number): ErrorKind {
  if (status === 400 || status === 422) return "invalid_input";
  if (status === 401) return "auth_failed";
  if (status === 402) return "insufficient_balance";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 423) return "account_suspended";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "service_unavailable";
  if (status >= 500) return "backend_error";
  return "unexpected_response";
}

/**
 * Statuses that, on a side-effecting request (call, message, purchase, transfer), do not prove that nothing
 * happened: a 5xx or a gateway timeout may come after the upstream acted. They map to `outcome_unknown`.
 */
export function isAmbiguousWriteStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

/** What to check before retrying a write whose outcome is unknown. */
export const CHECK_STATE_HINT =
  "Do NOT retry blindly: check the current state first (`vobiz calls list`, `vobiz cdr recent`, `vobiz sms messages list` or `vobiz account transactions`).";

/**
 * Error kind for an HTTP failure. Reads keep the retryable mapping; a write (`sideEffect`) answered with a 5xx or
 * 408 becomes `outcome_unknown` (exit 7, retryable: false) because the request may have taken effect.
 */
export function kindForResponse(status: number, sideEffect: boolean): ErrorKind {
  if (sideEffect && isAmbiguousWriteStatus(status)) return "outcome_unknown";
  return kindForStatus(status);
}

const MAX_BACKEND_MESSAGE = 300;

/** Pulls a human message out of a Vobiz error body without echoing the whole payload. */
export function extractBackendMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body.trim() ? body.trim().slice(0, MAX_BACKEND_MESSAGE) : undefined;
  const b = body as Record<string, unknown>;
  const cands = [b.message, b.error, b.detail, b.error_description, (b.error as Record<string, unknown> | undefined)?.message];
  for (const c of cands) if (typeof c === "string" && c.trim()) return c.trim().slice(0, MAX_BACKEND_MESSAGE);
  if (Array.isArray(b.errors) && b.errors.length) {
    const first = b.errors[0] as Record<string, unknown> | string;
    if (typeof first === "string") return first.slice(0, MAX_BACKEND_MESSAGE);
    if (first && typeof first.message === "string") return `${first.field ? first.field + ": " : ""}${first.message}`.slice(0, MAX_BACKEND_MESSAGE);
  }
  return undefined;
}

export function usage(message: string): VobizError {
  return new VobizError("invalid_input", message);
}
