/**
 * evaluateProviders() - the dual-marketplace decision engine.
 *
 * Pure function the control loop calls once per tick to answer: "given what
 * each marketplace's order book looks like right now, what would we pay on
 * each, and which one should be active?"
 *
 * It ties together the three tested primitives:
 *   1. Braiins effective price = its depth-aware `fillable_ask` (already in
 *      State as sat/EH/day) + overpay.
 *   2. NiceHash effective price = `lowestFillingPrice` (the operator-confirmed
 *      fill line) + overpay, from the live NiceHash order book.
 *   3. `selectProvider` - the 3.25% + sustained-window switch decision.
 *
 * Both effective prices are expressed in sat/PH/day (the operator-facing
 * unit and the unit `selectProvider` compares in). Overpay is the shared
 * `overpay_sat_per_eh_day` knob converted to sat/PH/day (÷1000).
 *
 * Everything here is side-effect free: no clients, no DB, no order mutations.
 * The tick driver feeds it observed data and persists the returned provider
 * state. In DRY-RUN this result is logged and surfaced only - nothing is
 * placed or cancelled.
 */

import {
  cheapestFillableForDepth,
  deepLiquidityPrice,
  desiredBidAboveFillable,
  lowestFillingPrice,
  type NiceHashOrderBookOrder,
} from '@hashrate-autopilot/nicehash-client';

import {
  selectProvider,
  type Provider,
  type ProviderSelectConfig,
  type ProviderSelectResult,
  type ProviderSelectState,
} from './provider-select.js';

export interface EvaluateProvidersInputs {
  /** Braiins depth-aware fillable ask this tick, sat/EH/day (State.fillable_ask_sat_per_eh_day). null if unavailable. */
  readonly braiinsFillableSatPerEhDay: number | null;

  /** Live NiceHash hashpower order book for the algorithm. null/empty if the poll failed. */
  readonly nicehashOrders: readonly NiceHashOrderBookOrder[] | null;
  /** marketFactor for the NiceHash algorithm (from GET algorithms). null if unavailable. */
  readonly nicehashMarketFactor: number | null;
  /** Only consider NiceHash orders in this market (e.g. "EU"/"USA"), matching your pool's region. Empty = all markets. */
  readonly nicehashMarket?: string;
  /** Dust floor (PH/s) for the NiceHash fill line - orders delivering at/below this don't set the line. Default 0. */
  readonly nicehashMinDeliveredPh?: number;
  /**
   * Our NiceHash target hashrate (PH/s). When > 0 the fill line is DEPTH-AWARE:
   * the cheapest price whose cumulative delivered supply (from the bottom of the
   * book up) covers this target - i.e. where enough real supply exists to fill
   * OUR order, not just the cheapest order catching a trickle. This is what stops
   * the daemon anchoring to a low-priced order receiving only scraps (e.g. a
   * 0.4801 order getting 1.3 PH/s while the real 1.4 EH/s supply sits at 0.4820),
   * which left the order priced below the true fill line and delivering nothing.
   * When 0/unset, falls back to `lowestFillingPrice` (cheapest order with any fill).
   */
  readonly nicehashTargetPh?: number;
  /**
   * Deep-liquidity threshold (EH/s). The NiceHash market is RATIONED this tick
   * when the book's cumulative delivered supply never reaches this - no sizeable
   * block to fill against. Used to stop the daemon chasing the price up into
   * thin scraps and to trigger the Braiins supplement. 0/undefined disables it.
   */
  readonly nicehashDeepLiquidityEh?: number;
  /**
   * #E: cumulative bottom-skip (EH/s) for the depth-aware fill line. After the
   * per-order dust floor, discard this much CUMULATIVE delivered supply from the
   * cheap end before counting toward the target, so the anchor sits above the
   * thin/volatile bottom slice of the book. 0/undefined = off.
   */
  readonly nicehashFillSkipBottomEh?: number;

  /** Shared overpay cushion, sat/PH/day (config.overpay_sat_per_eh_day ÷ 1000). */
  readonly overpaySatPerPhDay: number;

  /**
   * Marketplace fee %, added on top of each provider's bid to get its true
   * all-in cost for the SWITCH comparison only (the bid we actually submit is
   * unchanged). Default 0. Braiins runs fee-free during its beta, so
   * `braiinsFeePct` defaults to 0 today; set it when Braiins introduces a fee
   * so the 3.25% threshold stays a pure switching margin rather than something
   * you have to reverse-engineer against fees. NiceHash's marketplace fee goes
   * in `nicehashFeePct`.
   */
  readonly braiinsFeePct?: number;
  readonly nicehashFeePct?: number;

  /**
   * #60: the price NiceHash's live order is CURRENTLY set at (sat/PH/day), from
   * the order snapshot this tick. The switch decision uses
   * max(currentOrderPrice, effective) as NiceHash's cost so we don't park
   * Braiins on a cheaper DESIRED price that the order hasn't actually reached
   * yet (NiceHash decreases are capped + cooled down, so the live price lags
   * the target on the way down). When the order is PARKED its live price sits
   * far below the fill line, so max() naturally falls back to the effective
   * reactivation price - preventing a parked order from looking artificially
   * cheap and flapping the active provider back to NiceHash. null/undefined
   * (no live order, e.g. before first create) -> use effective alone.
   */
  readonly nicehashCurrentOrderPriceSatPerPhDay?: number | null;

  readonly switchConfig: ProviderSelectConfig;
  readonly prevProviderState: ProviderSelectState;
  readonly now: number;
}

export interface EvaluateProvidersResult {
  /** What we'd bid on Braiins this tick, sat/PH/day (fillable + overpay), fee-EXCLUSIVE — this is the price actually submitted. null if Braiins unpriceable. */
  readonly braiinsEffectiveSatPerPhDay: number | null;
  /** What we'd bid on NiceHash this tick, sat/PH/day (lowest filling + overpay), fee-EXCLUSIVE. null if NiceHash unpriceable. */
  readonly nicehashEffectiveSatPerPhDay: number | null;
  /** Braiins all-in cost used for the switch decision, sat/PH/day (effective × (1 + fee%)). null if unpriceable. */
  readonly braiinsCostSatPerPhDay: number | null;
  /** NiceHash all-in cost used for the switch decision, sat/PH/day (effective × (1 + fee%)). null if unpriceable. */
  readonly nicehashCostSatPerPhDay: number | null;
  /** NiceHash fill-line price before overpay, sat/PH/day (diagnostics). null if unpriceable. */
  readonly nicehashFillLineSatPerPhDay: number | null;
  /**
   * #60: the NiceHash price the switch decision actually compared on, sat/PH/day
   * = max(currentOrderPrice, effective). Surfaced for diagnostics/logging so the
   * operator can see we waited for the ACTUAL deliverable price. null if
   * unpriceable.
   */
  readonly nicehashSwitchBasisSatPerPhDay: number | null;
  /**
   * True when the NiceHash book lacks a deep-liquidity block (cumulative
   * delivered supply < nicehashDeepLiquidityEh). The daemon should not chase the
   * price up in this state; Braiins supplements instead. False when priceable or
   * the check is disabled.
   */
  readonly nicehashRationed: boolean;
  readonly selection: ProviderSelectResult;
}

function filterByMarket(
  orders: readonly NiceHashOrderBookOrder[],
  market: string | undefined,
): readonly NiceHashOrderBookOrder[] {
  if (!market) return orders;
  // Only filter when orders actually carry a market tag; if none do (schema
  // drift / different shape), fall back to the full book rather than dropping
  // everything and going dark.
  const tagged = orders.filter((o) => typeof o.market === 'string');
  if (tagged.length === 0) return orders;
  return tagged.filter((o) => o.market === market);
}

export function evaluateProviders(inputs: EvaluateProvidersInputs): EvaluateProvidersResult {
  // --- Braiins effective price ---
  const braiinsEffectiveSatPerPhDay =
    inputs.braiinsFillableSatPerEhDay !== null
      ? inputs.braiinsFillableSatPerEhDay / 1000 + inputs.overpaySatPerPhDay
      : null;

  // --- NiceHash effective price ---
  let nicehashFillLineSatPerPhDay: number | null = null;
  let nicehashEffectiveSatPerPhDay: number | null = null;
  let nicehashRationed = false;
  if (
    inputs.nicehashOrders &&
    inputs.nicehashOrders.length > 0 &&
    inputs.nicehashMarketFactor !== null &&
    inputs.nicehashMarketFactor > 0
  ) {
    const orders = filterByMarket(inputs.nicehashOrders, inputs.nicehashMarket);
    // #55: rationing check. The market is rationed when the book has no
    // deep-liquidity block (cumulative delivered supply < threshold EH). In that
    // state we don't chase the price up into thin scraps - Braiins supplements.
    const deepThresholdPh = (inputs.nicehashDeepLiquidityEh ?? 0) * 1000;
    nicehashRationed =
      deepThresholdPh > 0 &&
      deepLiquidityPrice(orders, deepThresholdPh, inputs.nicehashMarketFactor) === null;
    // Depth-aware anchor when we know our target: the cheapest price whose
    // cumulative delivered supply covers our order, so we bid where real supply
    // is (not to a cheaper order catching only a trickle). Falls back to the
    // cheapest-any-fill rule when no target is known.
    const targetPh = inputs.nicehashTargetPh ?? 0;
    // #E: BOTH filters now apply to the depth path (which is the path that
    // actually runs whenever a target is set - previously the dust floor was
    // only wired into the fallback, so the config knob silently did nothing).
    const fillLine =
      targetPh > 0
        ? cheapestFillableForDepth(orders, targetPh, inputs.nicehashMarketFactor, {
            minDeliveredPh: inputs.nicehashMinDeliveredPh ?? 0,
            skipBottomPh: (inputs.nicehashFillSkipBottomEh ?? 0) * 1000,
          })
        : lowestFillingPrice(orders, inputs.nicehashMarketFactor, {
            minDeliveredPh: inputs.nicehashMinDeliveredPh ?? 0,
          });
    if (fillLine.priceSatPerPhDay !== null) {
      nicehashFillLineSatPerPhDay = fillLine.priceSatPerPhDay;
      nicehashEffectiveSatPerPhDay = desiredBidAboveFillable(
        fillLine.priceSatPerPhDay,
        inputs.overpaySatPerPhDay,
        inputs.nicehashMarketFactor,
      ).priceSatPerPhDay;
    }
  }

  // Fee-adjusted all-in cost for the switch decision. The bid we submit stays
  // the raw effective price above; fees only affect which provider is cheaper.
  const braiinsFeePct = inputs.braiinsFeePct ?? 0;
  const nicehashFeePct = inputs.nicehashFeePct ?? 0;
  const braiinsCostSatPerPhDay =
    braiinsEffectiveSatPerPhDay !== null
      ? braiinsEffectiveSatPerPhDay * (1 + braiinsFeePct / 100)
      : null;
  // #60: compare on the ACTUAL deliverable price. When a live order price is
  // known, use max(currentOrderPrice, effective): on the way down the capped/
  // cooled-down live price lags the target, so this keeps NiceHash's cost at the
  // real (higher) live price until it genuinely converges - Braiins isn't parked
  // on a desired price the order hasn't reached. A parked order's live price is
  // far below the fill line, so max() yields the effective reactivation price
  // and the parked order can't look artificially cheap and cause a flap.
  const nicehashSwitchBasisSatPerPhDay =
    nicehashEffectiveSatPerPhDay === null
      ? null
      : inputs.nicehashCurrentOrderPriceSatPerPhDay != null
        ? Math.max(
            inputs.nicehashCurrentOrderPriceSatPerPhDay,
            nicehashEffectiveSatPerPhDay,
          )
        : nicehashEffectiveSatPerPhDay;
  const nicehashCostSatPerPhDay =
    nicehashSwitchBasisSatPerPhDay !== null
      ? nicehashSwitchBasisSatPerPhDay * (1 + nicehashFeePct / 100)
      : null;

  const selection = selectProvider(
    {
      braiinsSatPerPhDay: braiinsCostSatPerPhDay,
      nicehashSatPerPhDay: nicehashCostSatPerPhDay,
    },
    inputs.switchConfig,
    inputs.prevProviderState,
    inputs.now,
  );

  return {
    braiinsEffectiveSatPerPhDay,
    nicehashEffectiveSatPerPhDay,
    braiinsCostSatPerPhDay,
    nicehashCostSatPerPhDay,
    nicehashFillLineSatPerPhDay,
    nicehashSwitchBasisSatPerPhDay,
    nicehashRationed,
    selection,
  };
}

export type { Provider };
