/**
 * Fill-line pricing for the NiceHash hashpower order book.
 *
 * CONFIRMED MECHANIC (operator-verified 2026-07-22 on the live NiceHash
 * tradeview): a NiceHash order fills as long as its price is above the
 * lowest price currently getting filled on the order book. NiceHash is a
 * pay-your-bid, position-in-queue market - a fixed pool of miner supply
 * flows to the highest-priced BUY orders, and the "fill line" is the
 * cheapest order still receiving hashrate. Bid just above it (+overpay)
 * and supply reallocates to you.
 *
 * The order book (GET /main/api/v2/hashpower/orderBook/) is the list of
 * competing buy orders, each with a `price` (BTC per marketFactor-unit per
 * day) and an `acceptedSpeed` (hashrate that order is *currently being
 * delivered* - the "Speed EH/s" column in the UI).
 *
 * Important: the book is NOT strictly monotonic in practice. Observed on
 * the confirming screenshot: an order at 0.4836 was filling (Speed 0.0008)
 * while several *higher*-priced orders just above it (0.4838-0.4850) showed
 * Speed 0.0000 - order age, per-order limits, and pool differences all
 * perturb the strict price ordering. So the fill line must be read from
 * which orders are *actually receiving speed*, not from a clean price
 * cutoff. That's what {@link lowestFillingPrice} does, and it's the primary
 * anchor the controller should track for NiceHash.
 *
 * Two functions:
 *   - {@link lowestFillingPrice}   - THE confirmed rule: cheapest price
 *     among orders currently receiving hashrate. Bid = this + overpay.
 *   - {@link cheapestFillableForDepth} - size-aware conservative variant
 *     (the NiceHash mirror of Braiins' `cheapestAskForDepth`): the cheapest
 *     price whose cumulative delivered supply from the bottom up covers your
 *     whole target. For a small target relative to the market it collapses
 *     to ~the lowest filling price; it only diverges (bids higher) when your
 *     target is a meaningful fraction of total delivered supply. Kept as a
 *     guard for large orders.
 */

import type { NiceHashOrderBookOrder, NiceHashOrderBookResponse } from './client.js';
import { priceToSatPerEhDay, priceToSatPerPhDay, satPerPhDayToPrice } from './units.js';

export interface MarketBook {
  /** Orders for the selected market. */
  readonly orders: readonly NiceHashOrderBookOrder[];
  /** Authoritative marketFactor (H/s per unit) for this market's prices/speeds. */
  readonly marketFactor: number;
  /** Display unit for the marketFactor, e.g. "EH" - required verbatim on order mutations. */
  readonly displayMarketFactor: string;
  /** Which market key was actually used (e.g. "BTC"). */
  readonly market: string;
}

/**
 * Pull the orders + marketFactor for one market out of the live order-book
 * response. NiceHash nests everything under `stats.<currencyMarket>` (the key
 * is the currency, e.g. "BTC"), and each market carries its own `marketFactor`
 * (e.g. 1e18 = EH) which is the authoritative unit for that market's prices
 * and speeds. If the requested `market` isn't present, falls back to the first
 * available market so a stale/region-style config value (e.g. "EU") still
 * works. Returns null when the response has no usable market.
 */
export function extractMarketBook(
  response: NiceHashOrderBookResponse | null | undefined,
  market?: string,
): MarketBook | null {
  const stats = response?.stats;
  if (!stats || typeof stats !== 'object') return null;
  const keys = Object.keys(stats);
  if (keys.length === 0) return null;
  const key = market && stats[market] ? market : keys[0]!;
  const ms = stats[key];
  if (!ms) return null;
  const marketFactor = Number(ms.marketFactor);
  if (!Number.isFinite(marketFactor) || marketFactor <= 0) return null;
  return {
    orders: ms.orders ?? [],
    marketFactor,
    displayMarketFactor: ms.displayMarketFactor ?? 'EH',
    market: key,
  };
}

const H_PER_PH = 1e15;

export interface FillableResult {
  /**
   * Cheapest price at which cumulative delivered supply from orders priced
   * <= this level covers `targetPh`, expressed in the daemon's native unit
   * (sat/EH/day) so it slots straight into the existing decide() formula.
   * `null` when the book is empty.
   */
  readonly priceSatPerEhDay: number | null;
  /** Same price in sat/PH/day (the operator-facing unit). */
  readonly priceSatPerPhDay: number | null;
  /** Raw BTC-per-marketFactor-unit-per-day, for re-submitting to NiceHash. */
  readonly priceBtcPerUnitPerDay: number | null;
  /**
   * True when the whole book's delivered supply is less than `targetPh`.
   * The returned price is then the highest-priced order with delivered
   * supply (the best we can do) - bidding above it captures every
   * grabbable share, but the full target may not fill.
   */
  readonly thin: boolean;
  /** Cumulative delivered PH up to and including the returned price level. */
  readonly cumulativePh: number;
}

interface ParsedOrder {
  readonly priceBtc: number;
  readonly deliveredPh: number;
}

function parseOrders(
  orders: readonly NiceHashOrderBookOrder[],
  marketFactor: number,
): ParsedOrder[] {
  const out: ParsedOrder[] = [];
  for (const o of orders) {
    const priceBtc = Number(o.price);
    if (!Number.isFinite(priceBtc) || priceBtc <= 0) continue;
    // `acceptedSpeed` is in marketFactor units (same unit as limitSpeed);
    // convert to PH/s. Absent/zero acceptedSpeed = not filling = 0 grabbable.
    const acceptedUnits = Number(o.acceptedSpeed ?? 0);
    let deliveredPh = Number.isFinite(acceptedUnits)
      ? (Math.max(0, acceptedUnits) * marketFactor) / H_PER_PH
      : 0;
    // Phantom-order guard: the live book routinely reports an acceptedSpeed for
    // an order with ZERO assigned miners (rigsCount === 0) - a stale/settling
    // entry that is NOT actually receiving hashrate. Left in, such an order
    // anchors the fill line to a cheap price that delivers nothing (observed on
    // the live book: several 0.4800-0.4810 orders showing Speed > 0 with 0
    // miners while the real supply sat at 0.4820 with 51k miners). Treat an
    // order with no miners as delivering nothing so it can't set the fill line.
    // When rigsCount is absent (older book shape) we fall back to acceptedSpeed.
    if (o.rigsCount !== undefined && o.rigsCount <= 0) deliveredPh = 0;
    out.push({ priceBtc, deliveredPh });
  }
  return out;
}

export interface LowestFillingOpts {
  /**
   * Ignore orders delivering at or below this many PH/s when locating the
   * fill line. Default 0 = any order receiving *any* hashrate counts (the
   * literal confirmed rule). Raise it to stop a single dust order (e.g. the
   * 0.0008 EH/s order at 0.4836 in the confirming screenshot) from dragging
   * the anchor down below where supply reliably reallocates.
   */
  readonly minDeliveredPh?: number;
}

/**
 * THE confirmed NiceHash rule: the cheapest price among orders currently
 * receiving hashrate. An order priced above this fills; one priced below
 * does not. Bid = this price + overpay (see {@link desiredBidAboveFillable}).
 *
 * Reads the fill line from delivered speed, not from price ordering, so the
 * non-monotonic book (cheap orders filling while pricier ones don't) is
 * handled correctly. Returns `null` price when no order is receiving
 * hashrate (nothing to anchor to - the controller should skip the tick,
 * exactly as decide() does when Braiins' fillable is null).
 */
export function lowestFillingPrice(
  orders: readonly NiceHashOrderBookOrder[] | undefined,
  marketFactor: number,
  opts: LowestFillingOpts = {},
): FillableResult {
  const empty: FillableResult = {
    priceSatPerEhDay: null,
    priceSatPerPhDay: null,
    priceBtcPerUnitPerDay: null,
    thin: true,
    cumulativePh: 0,
  };
  if (!orders || orders.length === 0) return empty;

  const minDeliveredPh = opts.minDeliveredPh ?? 0;
  const filling = parseOrders(orders, marketFactor).filter((o) => o.deliveredPh > minDeliveredPh);
  if (filling.length === 0) return empty;

  let minPriceBtc = Infinity;
  let totalDeliveredPh = 0;
  for (const o of filling) {
    totalDeliveredPh += o.deliveredPh;
    if (o.priceBtc < minPriceBtc) minPriceBtc = o.priceBtc;
  }
  return toResult(minPriceBtc, marketFactor, false, totalDeliveredPh);
}

/**
 * Cheapest price at which cumulative delivered supply (from the bottom of
 * the book up) covers `targetPh`. Mirrors Braiins `cheapestAskForDepth`.
 */
export function cheapestFillableForDepth(
  orders: readonly NiceHashOrderBookOrder[] | undefined,
  targetPh: number,
  marketFactor: number,
): FillableResult {
  const empty: FillableResult = {
    priceSatPerEhDay: null,
    priceSatPerPhDay: null,
    priceBtcPerUnitPerDay: null,
    thin: true,
    cumulativePh: 0,
  };
  if (!orders || orders.length === 0) return empty;

  const parsed = parseOrders(orders, marketFactor).sort((a, b) => a.priceBtc - b.priceBtc);
  if (parsed.length === 0) return empty;

  let cumulative = 0;
  let lastDeliveringPriceBtc: number | null = null;
  for (const order of parsed) {
    if (order.deliveredPh <= 0) continue;
    cumulative += order.deliveredPh;
    lastDeliveringPriceBtc = order.priceBtc;
    if (cumulative >= targetPh) {
      return toResult(order.priceBtc, marketFactor, false, cumulative);
    }
  }

  // Ran out of delivered supply before covering the target - fall back to
  // the highest-priced order that's actually receiving hashrate.
  if (lastDeliveringPriceBtc === null) return empty;
  return toResult(lastDeliveringPriceBtc, marketFactor, true, cumulative);
}

/**
 * Deep-liquidity price: the cheapest price whose CUMULATIVE delivered supply
 * (from the bottom of the book up) reaches `thresholdPh` - i.e. where a sizeable
 * block of real hashrate sits. Returns `null` when the whole book's delivered
 * supply never reaches the threshold (the market is rationed / thin - no deep
 * block to anchor to).
 *
 * The operator's rule (2026-07-26): never chase NiceHash above the price where
 * sizeable hashrate (~1 EH) is available. So the daemon uses this two ways:
 *   - as a RATIONING signal: null => thin market => don't chase the price up
 *     (hold), and let Braiins supplement the shortfall.
 *   - `thresholdPh` is a config knob (nicehash_deep_liquidity_eh x 1000).
 */
export function deepLiquidityPrice(
  orders: readonly NiceHashOrderBookOrder[] | undefined,
  thresholdPh: number,
  marketFactor: number,
): number | null {
  if (!orders || orders.length === 0 || thresholdPh <= 0) return null;
  const parsed = parseOrders(orders, marketFactor).sort((a, b) => a.priceBtc - b.priceBtc);
  let cumulative = 0;
  for (const o of parsed) {
    if (o.deliveredPh <= 0) continue;
    cumulative += o.deliveredPh;
    if (cumulative >= thresholdPh) return priceToSatPerPhDay(o.priceBtc, marketFactor);
  }
  return null; // book never reaches the threshold -> no deep block (rationed)
}

function toResult(
  priceBtc: number,
  marketFactor: number,
  thin: boolean,
  cumulativePh: number,
): FillableResult {
  return {
    priceSatPerEhDay: priceToSatPerEhDay(priceBtc, marketFactor),
    priceSatPerPhDay: priceToSatPerPhDay(priceBtc, marketFactor),
    priceBtcPerUnitPerDay: priceBtc,
    thin,
    cumulativePh,
  };
}

export interface DesiredBid {
  readonly priceSatPerPhDay: number;
  readonly priceSatPerEhDay: number;
  readonly priceBtcPerUnitPerDay: number;
}

/**
 * Apply the overpay cushion above the fillable price: bid slightly above
 * the cheapest filling order so miner supply reallocates to us. Overpay is
 * expressed in sat/PH/day (the operator-facing knob, shared with Braiins);
 * the result is returned in all three units the daemon / API need.
 */
export function desiredBidAboveFillable(
  fillableSatPerPhDay: number,
  overpaySatPerPhDay: number,
  marketFactor: number,
): DesiredBid {
  const priceSatPerPhDay = fillableSatPerPhDay + overpaySatPerPhDay;
  return {
    priceSatPerPhDay,
    priceSatPerEhDay: priceSatPerPhDay * 1000,
    priceBtcPerUnitPerDay: satPerPhDayToPrice(priceSatPerPhDay, marketFactor),
  };
}
