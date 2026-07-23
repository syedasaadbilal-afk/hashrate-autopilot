/**
 * Custom error types for the NiceHash Hashpower API client.
 * Mirrors @hashrate-autopilot/braiins-client's error shape so callers that
 * already branch on `instanceof …ApiError` / `.status` need no new pattern.
 */

export class NiceHashApiError extends Error {
  public readonly status: number;
  public readonly endpoint: string;
  public readonly body: unknown;

  constructor(args: { status: number; endpoint: string; body?: unknown; message?: string }) {
    super(args.message ?? `NiceHash API ${args.endpoint} returned ${args.status}`);
    this.name = 'NiceHashApiError';
    this.status = args.status;
    this.endpoint = args.endpoint;
    this.body = args.body;
  }
}

export class NiceHashAuthMissingError extends Error {
  constructor() {
    super(
      'NiceHash API call requires org ID + API key + secret but at least one was not configured',
    );
    this.name = 'NiceHashAuthMissingError';
  }
}

export class NiceHashNetworkError extends Error {
  public readonly endpoint: string;

  constructor(endpoint: string, cause: unknown) {
    super(`NiceHash API network error on ${endpoint}: ${String(cause)}`, { cause });
    this.name = 'NiceHashNetworkError';
    this.endpoint = endpoint;
  }
}
