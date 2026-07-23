/**
 * NiceHash price-edit constraints (operator-confirmed 2026-07-22).
 *
 * NiceHash treats price increases and decreases asymmetrically:
 *   - DECREASE: only in whole steps of `minPriceDecreaseStepSatPerPhDay`
 *     (default 200 sat/PH/day), and no more often than once per
 *     `priceDecreaseCooldownMs` (default 10 minutes).
 *   - INCREASE: unrestricted - any amount, any time, no cooldown, no step.
 *
 * (For contrast, Braiins has a price-decrease cooldown too - read
 * dynamically from `min_bid_price_decrease_period_s` in its market
 * settings, so the daemon already adapts if Braiins changes it - but no
 * minimum step. That path lives in the daemon's gate.ts and is unaffected
 * by this module.)
 *
 * This pure function decides whether a proposed NiceHash price move is
 * allowed and, for decreases, snaps it to a whole number of 200-sat steps
 * that never lands BELOW the target (so we never overshoot past the fill
 * line while satisfying the step rule). It's the NiceHash analogue of the
 * Braiins EDIT_PRICE deadband + cooldown gate, ready to slot into the LIVE
 * NiceHash controller.
 *
 * Unit note: everything here is sat/PH/day. The 200 default is expressed in
 * that unit; if NiceHash's true minimum step turns out to be a different
 * unit, only the default (a config knob) changes - the logic is unit-agnostic.
 */

export const NICEHASH_DEFAULT_MIN_PRICE_DECREASE_STEP_SAT_PER_PH_DAY = 200;
export const NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS = 10 * 60_000;

/** Below this many sat/PH/day, a price move is treated as no change (float noise). */
const NOOP_EPSILON = 1e-6;

export interface NicehashEditConstraints {
  /** Minimum (and granularity of) a price decrease, sat/PH/day. Default 200. */
  readonly minPriceDecreaseStepSatPerPhDay?: number;
  /** Minimum time between successive price decreases, ms. Default 10 min. */
  readonly priceDecreaseCooldownMs?: number;
}

export type NicehashEditKind = 'NONE' | 'INCREASE' | 'DECREASE';

export type NicehashEditDenialReason =
  | 'NO_CHANGE'
  | 'DECREASE_COOLDOWN'
  | 'DECREASE_BELOW_MIN_STEP';

export interface NicehashPriceEditDecision {
  readonly allowed: boolean;
  readonly kind: NicehashEditKind;
  /**
   * The price to actually submit, sat/PH/day. For a decrease this is snapped
   * up to a whole number of steps at or above the desired price. null when no
   * edit should be sent.
   */
  readonly submitPriceSatPerPhDay: number | null;
  readonly denialReason: NicehashEditDenialReason | null;
  readonly reason: string;
}

export interface EvaluateNicehashPriceEditArgs {
  readonly currentPriceSatPerPhDay: number;
  readonly desiredPriceSatPerPhDay: number;
  /** When we last DECREASED this order's price, ms epoch. null if never / unknown. */
  readonly lastDecreaseAtMs: number | null;
  readonly now: number;
  readonly constraints?: NicehashEditConstraints;
}

export function evaluateNicehashPriceEdit(
  args: EvaluateNicehashPriceEditArgs,
): NicehashPriceEditDecision {
  const step =
    args.constraints?.minPriceDecreaseStepSatPerPhDay ??
    NICEHASH_DEFAULT_MIN_PRICE_DECREASE_STEP_SAT_PER_PH_DAY;
  const cooldownMs =
    args.constraints?.priceDecreaseCooldownMs ?? NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS;

  const delta = args.desiredPriceSatPerPhDay - args.currentPriceSatPerPhDay;

  if (Math.abs(delta) < NOOP_EPSILON) {
    return {
      allowed: false,
      kind: 'NONE',
      submitPriceSatPerPhDay: null,
      denialReason: 'NO_CHANGE',
      reason: 'no price change',
    };
  }

  // INCREASE - unrestricted.
  if (delta > 0) {
    return {
      allowed: true,
      kind: 'INCREASE',
      submitPriceSatPerPhDay: args.desiredPriceSatPerPhDay,
      denialReason: null,
      reason: `increase +${Math.round(delta)} sat/PH/day (unrestricted)`,
    };
  }

  // DECREASE - cooldown, then whole-step snapping.
  if (args.lastDecreaseAtMs !== null && args.now - args.lastDecreaseAtMs < cooldownMs) {
    const waitMin = (cooldownMs - (args.now - args.lastDecreaseAtMs)) / 60_000;
    return {
      allowed: false,
      kind: 'DECREASE',
      submitPriceSatPerPhDay: null,
      denialReason: 'DECREASE_COOLDOWN',
      reason: `decrease blocked: ${waitMin.toFixed(1)} min left on 10-min decrease cooldown`,
    };
  }

  const magnitude = -delta; // positive amount we want to come down by
  const steps = Math.floor(magnitude / step);
  if (steps < 1) {
    return {
      allowed: false,
      kind: 'DECREASE',
      submitPriceSatPerPhDay: null,
      denialReason: 'DECREASE_BELOW_MIN_STEP',
      reason: `decrease of ${Math.round(magnitude)} sat/PH/day is below the ${step} sat/PH/day minimum step`,
    };
  }

  // Snap DOWN by whole steps only - the submitted price stays at or above the
  // desired price, so we never overshoot below the fill line.
  const snappedMagnitude = steps * step;
  const submit = args.currentPriceSatPerPhDay - snappedMagnitude;
  return {
    allowed: true,
    kind: 'DECREASE',
    submitPriceSatPerPhDay: submit,
    denialReason: null,
    reason: `decrease -${snappedMagnitude} sat/PH/day (${steps}×${step} step; desired -${Math.round(magnitude)})`,
  };
}
