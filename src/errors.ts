/** Every error the SDK throws, so an app can catch them all with one `instanceof`. */
export class KiroraError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(`Kirora: ${message}`);
    this.name = 'KiroraError';
  }
}

/** `fetchUserToken` failed, didn't answer within 30 seconds, or there is no way to get a token. */
export class UserTokenError extends KiroraError {
  constructor(message = 'fetchUserToken failed', cause?: unknown) {
    super(message, cause);
    this.name = 'UserTokenError';
  }
}

/** Kirora refused a call: its HTTP `status`, error `code` and the gap it asked for. */
export class KiroraApiError extends KiroraError {
  constructor(
    public readonly status: number,
    public readonly code?: string,
    message?: string,
    /** From the `Retry-After` header, if any. */
    public readonly retryAfterMs?: number
  ) {
    super(message ?? `Kirora answered ${status}${code ? ` (${code})` : ''}`);
    this.name = 'KiroraApiError';
  }

  /** True for 408, 425, 429 and 5xx: the same call may succeed later. */
  get retryable(): boolean {
    return [408, 425, 429].includes(this.status) || this.status >= 500;
  }
}
