/**
 * Wraps the raw NiceHash client for the control loop, mirroring
 * `BraiinsService`:
 *
 * 1. **TTL cache** for the algorithm metadata (marketFactor / speedText),
 *    which changes maybe once per NiceHash release - refresh hourly rather
 *    than every tick.
 * 2. **Best-effort reads** - the order-book fetch catches and returns null on
 *    any failure so a NiceHash outage never aborts the tick (the dual-provider
 *    evaluation just treats NiceHash as unpriceable and holds the active
 *    provider).
 * 3. **Last-OK tracking** for outage visibility.
 *
 * This is read-only. The mutating methods (create/edit/refill/cancel/park)
 * live on the client and are wired in the LIVE step, not here.
 */

import {
  extractMarketBook,
  type MarketBook,
  type NiceHashAlgorithm,
  type NiceHashClient,
} from '@hashrate-autopilot/nicehash-client';

interface CachedValue<T> {
  value: T;
  cached_at: number;
}

export interface NiceHashServiceOptions {
  readonly client: NiceHashClient;
  /** Algorithm-metadata TTL. Default 1 hour. */
  readonly algorithmsTtlMs?: number;
  readonly now?: () => number;
}

export class NiceHashService {
  private readonly client: NiceHashClient;
  private readonly algorithmsTtlMs: number;
  private readonly now: () => number;

  private algorithmsCache: CachedValue<readonly NiceHashAlgorithm[]> | null = null;
  private lastApiOkAt: number | null = null;

  constructor(options: NiceHashServiceOptions) {
    this.client = options.client;
    this.algorithmsTtlMs = options.algorithmsTtlMs ?? 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Cached lookup of one algorithm's metadata (marketFactor etc). null if unavailable. */
  async getAlgorithm(algorithm: string): Promise<NiceHashAlgorithm | null> {
    try {
      if (!this.algorithmsCache || this.now() - this.algorithmsCache.cached_at >= this.algorithmsTtlMs) {
        const resp = await this.client.getAlgorithms();
        this.algorithmsCache = { value: resp.miningAlgorithms, cached_at: this.now() };
        this.lastApiOkAt = this.now();
      }
      return this.algorithmsCache.value.find((a) => a.algorithm === algorithm) ?? null;
    } catch (err) {
      console.warn(`[nicehash] getAlgorithm(${algorithm}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Best-effort order book for one algorithm + market, parsed into the flat
   * orders list plus the market's own marketFactor. Fetches the whole book in
   * one request (large page size) so the fill line is computed from the full
   * depth. null on any failure or when the market has no usable data.
   */
  async getMarketBook(algorithm: string, market?: string): Promise<MarketBook | null> {
    try {
      const resp = await this.client.getOrderBook(algorithm);
      this.lastApiOkAt = this.now();
      const book = extractMarketBook(resp, market);
      if (!book) {
        console.warn(
          `[nicehash] orderBook(${algorithm}) returned no usable market (wanted ${market ?? 'first'})`,
        );
        return null;
      }
      return book;
    } catch (err) {
      console.warn(`[nicehash] getMarketBook(${algorithm}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  getLastApiOkAt(): number | null {
    return this.lastApiOkAt;
  }
}
