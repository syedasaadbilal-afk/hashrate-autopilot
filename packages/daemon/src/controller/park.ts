/**
 * Unified "park" pricing for BOTH marketplaces.
 *
 * Neither provider is cancelled on a routine switch. Both are pay-your-bid, so
 * a bid/order sitting BELOW the fill line delivers zero hashrate and costs
 * zero, while staying alive for a free, instant reactivation (raising the
 * price is an increase, which neither NiceHash nor Braiins restricts - only
 * decreases carry a cooldown/step). NiceHash additionally can't be paused and
 * charges a ~1,000-sat fee to place a new order, which is what forced the
 * park design; applying the same design to Braiins keeps the handover
 * symmetric and avoids any recreate churn there too.
 *
 * So the dual-provider handover is uniform:
 *   - loser  → PARK  (drop price to `computeParkPrice`, a decrease)
 *   - winner → track (raise price back to fill line + overpay, an increase)
 *   - CANCEL is reserved for a hard teardown (provider disabled), never for
 *     switching.
 *
 * The per-market EDIT constraints still apply to the parking decrease:
 * NiceHash's 200 sat/PH/day step + 10-min cooldown (via
 * `evaluateNicehashPriceEdit`), Braiins' decrease cooldown from its market
 * settings with no min-step (via the existing gate.ts). Only the *price
 * target* is shared - this function.
 */

export interface ComputeParkPriceArgs {
  /** Current fill line for the provider, sat/PH/day. */
  readonly fillLineSatPerPhDay: number;
  /** How far below the fill line to sit, sat/PH/day (the shared `park_margin`). */
  readonly marginSatPerPhDay: number;
  /** Provider minimum allowed price, sat/PH/day. Park never goes below this. Default 0. */
  readonly floorSatPerPhDay?: number;
}

/**
 * Price to park at: `fillLine - margin`, floored at the provider minimum. Pick
 * a margin comfortably larger than normal fill-line jitter so a parked order
 * stays unmatched even if the market dips.
 */
export function computeParkPrice(args: ComputeParkPriceArgs): number {
  const floor = args.floorSatPerPhDay ?? 0;
  return Math.max(floor, args.fillLineSatPerPhDay - args.marginSatPerPhDay);
}

const PARK_EPSILON = 1e-6;

/** True when the current price is already at or below the park price (idle). */
export function isParked(currentPriceSatPerPhDay: number, parkPriceSatPerPhDay: number): boolean {
  return currentPriceSatPerPhDay <= parkPriceSatPerPhDay + PARK_EPSILON;
}
