/**
 * NiceHash Hashpower API v2 client - hand-rolled typed wrapper (NiceHash
 * doesn't publish a machine-readable OpenAPI spec the way Braiins does, so
 * there's no codegen step here; types below are typed from NiceHash's own
 * reference client examples and probed responses, and deliberately carry a
 * `[key: string]: unknown` index signature so an unrecognised field doesn't
 * break parsing - only the fields this client actually reads are typed).
 *
 * Exposes the GET subset (algorithms, order book, my orders, pools) plus
 * POST/PUT/DELETE for order mutations. All mutating + account-scoped calls
 * require the signed X-Auth header (see ./auth.ts); market data (algorithms)
 * is public.
 *
 * Retry policy mirrors @hashrate-autopilot/braiins-client:
 *   - 429 - retried with exponential backoff (safe; rejected pre-commit).
 *   - 5xx - retried on GETs and cancel only (idempotent). NOT retried on
 *     create/edit/refill - outcome may be indeterminate server-side.
 */

import {
  hasCredentials,
  signRequest,
  type MaybeNiceHashCredentials,
  type NiceHashCredentials,
} from './auth.js';
import { NiceHashApiError, NiceHashAuthMissingError, NiceHashNetworkError } from './errors.js';

export const NICEHASH_BASE_URL = 'https://api2.nicehash.com';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface NiceHashAlgorithm {
  readonly algorithm: string; // e.g. "SHA256"
  readonly title: string;
  readonly speedText: string; // e.g. "TH/s" - the unit marketFactor is denominated in
  readonly marketFactor: number; // H/s represented by "1" unit of price/limit for this algorithm
  readonly displayMarketFactor: string;
}

export interface NiceHashAlgorithmsResponse {
  readonly miningAlgorithms: readonly NiceHashAlgorithm[];
  readonly [key: string]: unknown;
}

export interface NiceHashOrderBookOrder {
  readonly id: string;
  readonly price: string; // BTC per marketFactor-unit of speed, per day
  readonly limitSpeed?: string;
  readonly acceptedSpeed?: string;
  readonly type?: { readonly code: string };
  readonly market?: string;
  readonly algorithm?: { readonly algorithm: string };
  readonly [key: string]: unknown;
}

export interface NiceHashOrderBookResponse {
  readonly orders: readonly NiceHashOrderBookOrder[];
  readonly [key: string]: unknown;
}

export interface NiceHashMyOrder {
  readonly id: string;
  readonly price: string;
  readonly limitSpeed?: string;
  readonly acceptedSpeed?: string;
  /** Cumulative BTC actually paid out against this order so far. */
  readonly payedAmount?: string;
  /** Total BTC budget the order was created/refilled with. */
  readonly amount?: string;
  readonly status?: { readonly code: string };
  readonly market?: string;
  readonly algorithm?: { readonly algorithm: string };
  readonly poolId?: string;
  readonly [key: string]: unknown;
}

export interface NiceHashMyOrdersResponse {
  readonly list: readonly NiceHashMyOrder[];
  readonly [key: string]: unknown;
}

export interface NiceHashPool {
  readonly id: string;
  readonly name: string;
  readonly algorithm?: { readonly algorithm: string };
  readonly stratumHostname?: string;
  readonly stratumPort?: number;
  readonly username?: string;
  readonly [key: string]: unknown;
}

export interface NiceHashPoolsResponse {
  readonly list: readonly NiceHashPool[];
  readonly [key: string]: unknown;
}

export interface CreateOrderParams {
  readonly market: string;
  readonly algorithm: string;
  /** Total BTC budget for the order (NiceHash's `amount`). */
  readonly amountBtc: number;
  readonly priceBtcPerUnitPerDay: number;
  readonly limitSpeedUnits: number;
  readonly poolId: string;
  /** From GET algorithms - required by NiceHash on every order mutation. */
  readonly marketFactor: number;
  readonly displayMarketFactor: string;
  readonly type?: 'STANDARD';
}

export interface CreateOrderResponse {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface EditOrderPriceAndLimitParams {
  readonly orderId: string;
  readonly priceBtcPerUnitPerDay: number;
  readonly limitSpeedUnits: number;
  readonly marketFactor: number;
  readonly displayMarketFactor: string;
}

export interface RefillOrderParams {
  readonly orderId: string;
  readonly amountBtc: number;
}

export interface GetMyOrdersOpts {
  readonly limit?: number;
}

export interface NiceHashClientConfig extends MaybeNiceHashCredentials {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Max retry attempts for transient failures (429, 5xx when safe). Default 3. */
  readonly maxRetries?: number;
  /** Sleep function (override for tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock override for tests (feeds X-Time). */
  readonly now?: () => number;
}

export interface NiceHashClient {
  /** Public, no auth: algorithm metadata (marketFactor, speedText, etc). */
  getAlgorithms(): Promise<NiceHashAlgorithmsResponse>;
  /**
   * Signed GET despite being market data - NiceHash's own reference client
   * puts this under its authenticated `private_api`, so it requires the
   * X-Auth header even though the data itself (the order book) is public.
   */
  getOrderBook(algorithm: string): Promise<NiceHashOrderBookResponse>;
  getMyOrders(
    algorithm: string,
    market: string,
    opts?: GetMyOrdersOpts,
  ): Promise<NiceHashMyOrdersResponse>;
  getPools(): Promise<NiceHashPoolsResponse>;
  createOrder(params: CreateOrderParams): Promise<CreateOrderResponse>;
  editOrderPriceAndLimit(params: EditOrderPriceAndLimitParams): Promise<void>;
  refillOrder(params: RefillOrderParams): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
}

export function createNiceHashClient(config: NiceHashClientConfig = {}): NiceHashClient {
  const baseUrl = config.baseUrl ?? NICEHASH_BASE_URL;
  const maxRetries = config.maxRetries ?? 3;
  const sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;

  const creds = { orgId: config.orgId, apiKey: config.apiKey, apiSecret: config.apiSecret };

  const requireCreds = (): NiceHashCredentials => {
    if (!hasCredentials(creds)) throw new NiceHashAuthMissingError();
    return creds;
  };

  const isTransient = (
    err: unknown,
    opts: { retryOn5xx: boolean; retryOnNetworkError: boolean },
  ): boolean => {
    if (err instanceof NiceHashApiError) {
      if (err.status === 429) return true;
      if (opts.retryOn5xx && err.status >= 500 && err.status < 600) return true;
      return false;
    }
    if (err instanceof NiceHashNetworkError) return opts.retryOnNetworkError;
    return false;
  };

  const withRetry = async <T>(
    endpoint: string,
    fn: () => Promise<T>,
    opts: { retryOn5xx: boolean; retryOnNetworkError: boolean },
  ): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const isLast = attempt >= maxRetries;
        if (isLast || !isTransient(err, opts)) throw err;
        const delay = Math.min(200 * 2 ** (attempt - 1), 2000);
        await sleep(delay);
      }
    }
    throw lastErr;
  };

  const rawRequest = async (
    endpoint: string,
    method: string,
    path: string,
    query: string,
    body: unknown,
    auth: 'PUBLIC' | 'SIGNED',
  ): Promise<unknown> => {
    const url = baseUrl + path + (query ? `?${query}` : '');
    const bodyStr = body !== undefined ? JSON.stringify(body) : null;

    let headers: Record<string, string> = { accept: 'application/json' };
    if (auth === 'SIGNED') {
      const c = requireCreds();
      headers = { ...headers, ...signRequest(c, method, path, query, bodyStr, now) };
    } else if (bodyStr !== null) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(bodyStr !== null ? { body: bodyStr } : {}),
      });
    } catch (err) {
      throw new NiceHashNetworkError(endpoint, err);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw new NiceHashApiError({ status: response.status, endpoint, body: parsed });
    }
    return parsed;
  };

  const read = <T>(
    endpoint: string,
    method: string,
    path: string,
    query: string,
    auth: 'PUBLIC' | 'SIGNED',
  ): Promise<T> =>
    withRetry(
      endpoint,
      () => rawRequest(endpoint, method, path, query, undefined, auth) as Promise<T>,
      { retryOn5xx: true, retryOnNetworkError: true },
    );

  // Mutations (create/edit/refill): never retry 5xx or network errors -
  // outcome may be indeterminate on the server. 429 is safe (pre-commit).
  const mutate = <T>(endpoint: string, method: string, path: string, body: unknown): Promise<T> =>
    withRetry(endpoint, () => rawRequest(endpoint, method, path, '', body, 'SIGNED') as Promise<T>, {
      retryOn5xx: false,
      retryOnNetworkError: false,
    });

  // Cancel is idempotent - retry more liberally.
  const cancel = (endpoint: string, path: string): Promise<void> =>
    withRetry(
      endpoint,
      async () => {
        await rawRequest(endpoint, 'DELETE', path, '', undefined, 'SIGNED');
      },
      { retryOn5xx: true, retryOnNetworkError: true },
    );

  return {
    getAlgorithms: () =>
      read<NiceHashAlgorithmsResponse>(
        'GET /main/api/v2/mining/algorithms/',
        'GET',
        '/main/api/v2/mining/algorithms/',
        '',
        'PUBLIC',
      ),

    getOrderBook: (algorithm: string) =>
      read<NiceHashOrderBookResponse>(
        'GET /main/api/v2/hashpower/orderBook/',
        'GET',
        '/main/api/v2/hashpower/orderBook/',
        `algorithm=${encodeURIComponent(algorithm)}`,
        'SIGNED',
      ),

    getMyOrders: (algorithm: string, market: string, opts: GetMyOrdersOpts = {}) => {
      const limit = opts.limit ?? 100;
      const query = `algorithm=${encodeURIComponent(algorithm)}&market=${encodeURIComponent(market)}&ts=${Date.now()}&limit=${limit}&op=LT`;
      return read<NiceHashMyOrdersResponse>(
        'GET /main/api/v2/hashpower/myOrders',
        'GET',
        '/main/api/v2/hashpower/myOrders',
        query,
        'SIGNED',
      );
    },

    getPools: () =>
      read<NiceHashPoolsResponse>(
        'GET /main/api/v2/pools/',
        'GET',
        '/main/api/v2/pools/',
        '',
        'SIGNED',
      ),

    createOrder: (params: CreateOrderParams) =>
      mutate<CreateOrderResponse>(
        'POST /main/api/v2/hashpower/order/',
        'POST',
        '/main/api/v2/hashpower/order/',
        {
          market: params.market,
          algorithm: params.algorithm,
          amount: params.amountBtc.toFixed(8),
          price: params.priceBtcPerUnitPerDay.toFixed(8),
          limit: params.limitSpeedUnits.toFixed(8),
          poolId: params.poolId,
          type: params.type ?? 'STANDARD',
          marketFactor: params.marketFactor,
          displayMarketFactor: params.displayMarketFactor,
        },
      ),

    editOrderPriceAndLimit: (params: EditOrderPriceAndLimitParams) =>
      mutate<void>(
        `POST /main/api/v2/hashpower/order/${params.orderId}/updatePriceAndLimit/`,
        'POST',
        `/main/api/v2/hashpower/order/${params.orderId}/updatePriceAndLimit/`,
        {
          price: params.priceBtcPerUnitPerDay.toFixed(8),
          limit: params.limitSpeedUnits.toFixed(8),
          marketFactor: params.marketFactor,
          displayMarketFactor: params.displayMarketFactor,
        },
      ),

    refillOrder: (params: RefillOrderParams) =>
      mutate<void>(
        `POST /main/api/v2/hashpower/order/${params.orderId}/refill/`,
        'POST',
        `/main/api/v2/hashpower/order/${params.orderId}/refill/`,
        { amount: params.amountBtc.toFixed(8) },
      ),

    cancelOrder: (orderId: string) =>
      cancel('DELETE /main/api/v2/hashpower/order/{id}', `/main/api/v2/hashpower/order/${orderId}`),
  };
}
