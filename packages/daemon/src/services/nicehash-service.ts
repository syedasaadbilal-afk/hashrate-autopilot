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
  phToSpeedUnits,
  priceToSatPerPhDay,
  roundToNicehashPriceTick,
  satPerPhDayToPrice,
  type MarketBook,
  type NiceHashAlgorithm,
  type NiceHashClient,
} from '@hashrate-autopilot/nicehash-client';

/**
 * Our current NiceHash order for the algo/market, reconciled from the API
 * each tick (NiceHash is the source of truth - no local ledger, mirroring how
 * the Braiins side reconciles owned bids from /spot/bid). null price/remaining
 * when the shape couldn't be parsed - logged verbosely so a DRY-RUN soak
 * reveals any shape mismatch before real money moves.
 */
export interface NiceHashOrderSnapshot {
  readonly exists: boolean;
  readonly orderId: string | null;
  readonly currentPriceSatPerPhDay: number | null;
  readonly remainingBtc: number | null;
  /** BTC consumed on the order so far (payedAmount). null if unknown. */
  readonly spentBtc: number | null;
  /** Live accepted hashrate on the order, PH/s. null if unknown. */
  readonly acceptedSpeedPh: number | null;
  /** Order speed limit (target), PH/s. null if unknown. */
  readonly limitPh: number | null;
  /** Order status code (e.g. 'ACTIVE'). null if unknown. */
  readonly statusCode: string | null;
  /**
   * True only when the orders API call completed cleanly (whether or not an
   * order was found). False when the lookup failed (network/API error) so the
   * result is UNKNOWN, not a confirmed "no order". The controller must never
   * CREATE a new order on an unknown lookup - that's how a transient blip would
   * otherwise open a duplicate order. See tick.ts.
   */
  readonly lookupOk: boolean;
  /** Raw order object, for diagnostics in the DRY-RUN validation logs. */
  readonly raw?: unknown;
}

export interface NiceHashLiveParams {
  readonly algorithm: string;
  readonly market: string;
  readonly poolId: string;
  readonly marketFactor: number;
  readonly displayMarketFactor: string;
}

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

  /**
   * Our current order for the algo/market, from GET myOrders. Parsed
   * defensively because the authenticated response shape is unverified - the
   * raw order is attached so a DRY-RUN log can confirm the fields before LIVE.
   * `marketFactor` (from the order book this tick) converts the order price to
   * sat/PH/day. Returns exists:false when we have no active order.
   */
  async getMyOrder(
    algorithm: string,
    market: string,
    marketFactor: number,
  ): Promise<NiceHashOrderSnapshot> {
    // Confirmed "no order" (the API answered cleanly): lookupOk = true.
    const confirmedNone: NiceHashOrderSnapshot = {
      exists: false,
      orderId: null,
      currentPriceSatPerPhDay: null,
      remainingBtc: null,
      spentBtc: null,
      acceptedSpeedPh: null,
      limitPh: null,
      statusCode: null,
      lookupOk: true,
    };
    // Unknown result (the API call failed): lookupOk = false so the controller
    // holds instead of assuming there's no order and creating a duplicate.
    const failedLookup: NiceHashOrderSnapshot = { ...confirmedNone, lookupOk: false };
    try {
      const resp = await this.client.getMyOrders(algorithm, market);
      this.lastApiOkAt = this.now();
      const list = Array.isArray(resp.list) ? resp.list : [];
      // "Active" = not cancelled/completed/expired, judged by the order STATUS
      // code only. We deliberately do NOT use the transient `alive` flag here:
      // NiceHash flips `alive` to false for a live ACTIVE order whenever it's
      // momentarily receiving no hashrate, and treating that as "dead" made the
      // controller briefly see no order and want to CREATE a duplicate (caught
      // in DRY-RUN, 2026-07-24). Be permissive: only a terminal status is dead.
      const active = list.filter((o) => {
        const status = (o.status as { code?: string } | undefined)?.code ?? '';
        const dead = /CANCELLED|COMPLETED|DEAD|EXPIRED/i.test(status);
        return !dead;
      });
      const order = active[0];
      if (!order) {
        // Distinguish "no orders at all" from "orders exist but all looked
        // dead" - the latter means the status filter didn't recognise the
        // live order and the autopilot would wrongly try to CREATE a new one.
        if (list.length > 0) {
          console.info(
            `[nicehash] order snapshot: none active out of ${list.length} returned; ` +
              `statuses=${list.map((o) => (o.status as { code?: string } | undefined)?.code ?? '?').join(',')}`,
          );
        } else {
          console.info('[nicehash] order snapshot: no orders returned for this algorithm/market');
        }
        return confirmedNone;
      }
      const priceBtc = Number(order.price);
      const amount = Number(order.amount ?? 0);
      // `availableAmount` is the SPENDABLE budget - `amount` minus NiceHash's
      // creation fee. The order runs until payedAmount reaches availableAmount,
      // and NiceHash's own UI shows remaining = availableAmount - payedAmount.
      // Using `amount` here over-stated remaining by the fee (~7k sats), so the
      // refill threshold never tripped and top-ups didn't fire. Prefer
      // availableAmount; fall back to amount only if it's missing.
      const availableRaw = Number((order as Record<string, unknown>)['availableAmount']);
      const available = Number.isFinite(availableRaw) && availableRaw > 0 ? availableRaw : amount;
      const payed = Number(order.payedAmount ?? 0);
      const remainingBtc =
        Number.isFinite(available) && Number.isFinite(payed) ? available - payed : null;
      const priceSat = Number.isFinite(priceBtc) ? priceToSatPerPhDay(priceBtc, marketFactor) : null;
      // NiceHash reports speed/limit in the display unit (EH for SHA256 BTC);
      // ×1000 converts EH→PH. Defensive Number() parse; null if not present.
      const raw = order as Record<string, unknown>;
      const acceptedRaw = Number(raw['acceptedCurrentSpeed']);
      const limitRaw = Number(raw['limit']);
      const acceptedSpeedPh = Number.isFinite(acceptedRaw) ? acceptedRaw * 1000 : null;
      const limitPh = Number.isFinite(limitRaw) ? limitRaw * 1000 : null;
      const spentBtc = Number.isFinite(payed) ? payed : null;
      const statusCode = (order.status as { code?: string } | undefined)?.code ?? null;
      // One-line validation snapshot: lets an operator confirm (in DRY-RUN,
      // before going LIVE) that the daemon parses their real order correctly -
      // the id/price/remaining should match what NiceHash's own UI shows.
      console.info(
        `[nicehash] order snapshot: id=${order.id} price=${priceSat ?? '?'} sat/PH/day ` +
          `remainingBtc=${remainingBtc ?? '?'} status=${(order.status as { code?: string } | undefined)?.code ?? '?'} ` +
          `raw=${JSON.stringify(order)}`,
      );
      return {
        exists: true,
        orderId: order.id,
        currentPriceSatPerPhDay: priceSat,
        remainingBtc,
        spentBtc,
        acceptedSpeedPh,
        limitPh,
        statusCode,
        lookupOk: true,
        raw: order,
      };
    } catch (err) {
      console.warn(`[nicehash] getMyOrder(${algorithm}/${market}) failed: ${(err as Error).message}`);
      return failedLookup;
    }
  }

  // ---- Mutations (LIVE only; the tick gates these on run_mode) --------------

  async createOrder(
    p: NiceHashLiveParams,
    priceSatPerPhDay: number,
    targetPh: number,
    amountBtc: number,
  ): Promise<string> {
    const res = await this.client.createOrder({
      market: p.market,
      algorithm: p.algorithm,
      amountBtc,
      // NiceHash rejects >4-decimal prices (error 2997); quantize to its tick.
      priceBtcPerUnitPerDay: roundToNicehashPriceTick(
        satPerPhDayToPrice(priceSatPerPhDay, p.marketFactor),
      ),
      limitSpeedUnits: phToSpeedUnits(targetPh, p.marketFactor),
      poolId: p.poolId,
      marketFactor: p.marketFactor,
      displayMarketFactor: p.displayMarketFactor,
    });
    this.lastApiOkAt = this.now();
    return res.id;
  }

  async editOrderPrice(
    p: NiceHashLiveParams,
    orderId: string,
    priceSatPerPhDay: number,
    // The limit (speed cap) to send. NiceHash's updatePriceAndLimit rejects a
    // limit DECREASE with a 400, so callers must pass the order's CURRENT limit
    // (or higher) here - never the config target if that's lower. See
    // execute-nicehash.ts.
    limitPh: number,
  ): Promise<void> {
    await this.client.editOrderPriceAndLimit({
      orderId,
      // NiceHash rejects >4-decimal prices (error 2997); quantize to its tick.
      priceBtcPerUnitPerDay: roundToNicehashPriceTick(
        satPerPhDayToPrice(priceSatPerPhDay, p.marketFactor),
      ),
      limitSpeedUnits: phToSpeedUnits(limitPh, p.marketFactor),
      marketFactor: p.marketFactor,
      displayMarketFactor: p.displayMarketFactor,
    });
    this.lastApiOkAt = this.now();
  }

  async refillOrder(orderId: string, amountBtc: number): Promise<void> {
    await this.client.refillOrder({ orderId, amountBtc });
    this.lastApiOkAt = this.now();
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId);
    this.lastApiOkAt = this.now();
  }

  getLastApiOkAt(): number | null {
    return this.lastApiOkAt;
  }
}
