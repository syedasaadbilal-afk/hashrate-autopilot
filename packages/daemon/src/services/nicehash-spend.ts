/**
 * B2: NiceHash lifetime spend tracker.
 *
 * Sums `payedAmount` across every NiceHash order for the configured
 * algorithm/market - active + terminal - to derive true lifetime spend.
 * Fixes the bug where lifetime P&L counted only the CURRENT order's
 * payedAmount (via the provider evaluation snapshot in tick.ts), so a
 * completed or expired order's spend vanished entirely once a new order
 * replaced it, understating true spend.
 *
 * Deliberately mirrors services/account-spend.ts (the Braiins-side
 * equivalent):
 *   - Terminal orders (CANCELLED/COMPLETED/DEAD/EXPIRED) are immutable once
 *     the status flips. We upsert each one into `nicehash_orders_cache` the
 *     first time we see it, then count them from the DB sum on every
 *     subsequent refresh - never re-reading their payed amount.
 *   - The active order is always read live; its payed amount increases as
 *     NiceHash bills it.
 *   - A small in-memory TTL cache sits on top so back-to-back dashboard
 *     refreshes don't hit the repo + wire every poll.
 *
 * Unlike the Braiins side, there's no real multi-page pagination here yet -
 * see the caveat on NiceHashService.getAllOrdersSpend. This service still
 * caches whatever the single page returns, so once a terminal order is
 * cached it survives even if it later falls off that page.
 */

import type { NiceHashService } from './nicehash-service.js';
import type { NicehashOrdersCacheRepo } from '../state/repos/nicehash_orders_cache.js';

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export interface NiceHashSpendSnapshot {
  /** Total spend across every order (active + terminal), sats. */
  readonly total_sat: number;
  /** Spend from terminal orders (CANCELLED/COMPLETED/DEAD/EXPIRED). */
  readonly closed_sat: number;
  /** Live in-flight spend from the currently active order. */
  readonly active_sat: number;
  readonly orders_seen: number;
  readonly fetched_at_ms: number;
}

export interface NiceHashSpendOptions {
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

/** Resolves the CURRENT algorithm/market to query, read fresh on every fetch
 * (not fixed at construction) so an operator changing `nicehash_market` on
 * the live-editable Config page takes effect without a daemon restart -
 * matching how the rest of the dual-provider config is read per-tick. null
 * when NiceHash isn't configured yet (algorithm/market unresolved). */
export type NiceHashAlgorithmMarketResolver = () => Promise<{
  algorithm: string;
  market: string;
} | null>;

export class NiceHashSpendService {
  private readonly svc: NiceHashService;
  private readonly repo: NicehashOrdersCacheRepo;
  private readonly resolveAlgorithmMarket: NiceHashAlgorithmMarketResolver;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private snapshotCache: NiceHashSpendSnapshot | null = null;
  private inflight: Promise<NiceHashSpendSnapshot | null> | null = null;

  constructor(
    svc: NiceHashService,
    repo: NicehashOrdersCacheRepo,
    resolveAlgorithmMarket: NiceHashAlgorithmMarketResolver,
    opts: NiceHashSpendOptions = {},
  ) {
    this.svc = svc;
    this.repo = repo;
    this.resolveAlgorithmMarket = resolveAlgorithmMarket;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  async getLifetimeSpend(): Promise<NiceHashSpendSnapshot | null> {
    const fresh =
      this.snapshotCache && this.now() - this.snapshotCache.fetched_at_ms < this.cacheTtlMs;
    if (fresh) return this.snapshotCache;
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchAndSum().finally(() => {
      this.inflight = null;
    });
    const result = await this.inflight;
    if (result) this.snapshotCache = result;
    return result;
  }

  /**
   * Wipe the persistent cache and the in-memory snapshot so the very next
   * `getLifetimeSpend` call re-fetches and re-populates the cache from
   * scratch. Mirrors AccountSpendService.rebuild().
   */
  async rebuild(): Promise<void> {
    await this.repo.clear();
    this.snapshotCache = null;
  }

  private async fetchAndSum(): Promise<NiceHashSpendSnapshot | null> {
    const target = await this.resolveAlgorithmMarket();
    if (!target || !target.algorithm || !target.market) {
      // NiceHash not configured / market not resolved yet - nothing to fetch.
      // Caller falls back to the current-order-only figure.
      return null;
    }

    const closedFromCache = await this.repo.sumPayedAmountSat();
    const cachedIds = await this.repo.allIds();

    const entries = await this.svc.getAllOrdersSpend(target.algorithm, target.market);
    // An empty result can mean "no orders" OR "the API call failed" -
    // getAllOrdersSpend already logs the failure and returns []. We can't
    // distinguish here, so on empty AND an empty cache, prefer null (unknown)
    // over falsely reporting 0 - mirrors AccountSpendService returning null
    // on a failed page fetch. Once anything has ever been cached, an empty
    // live fetch just means "nothing new this time," not "spend is 0".
    if (entries.length === 0 && cachedIds.size === 0) {
      return null;
    }

    let closedNew = 0;
    let active = 0;
    const fetchStart = this.now();

    for (const entry of entries) {
      if (entry.terminal) {
        if (!cachedIds.has(entry.orderId)) {
          closedNew += entry.payedAmountSat;
          cachedIds.add(entry.orderId);
          await this.repo.upsert(
            { nicehash_order_id: entry.orderId, payed_amount_sat: entry.payedAmountSat },
            fetchStart,
          );
        }
      } else {
        // Active - always counted live, never cached (mirrors AccountSpendService).
        active += entry.payedAmountSat;
      }
    }

    const closed = closedFromCache + closedNew;
    const total = closed + active;
    console.info(
      `[nicehash-spend] summary: seen=${entries.length} cached_terminals=${cachedIds.size} ` +
        `closed_sat=${Math.round(closed)} active_sat=${Math.round(active)} total_sat=${Math.round(total)}`,
    );
    return {
      total_sat: Math.round(total),
      closed_sat: Math.round(closed),
      active_sat: Math.round(active),
      orders_seen: entries.length,
      fetched_at_ms: fetchStart,
    };
  }
}
