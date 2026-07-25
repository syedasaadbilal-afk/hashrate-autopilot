/**
 * NiceHash price-edit constraints (operator-confirmed 2026-07-22, corrected
 * 2026-07-25 against the LIVE API).
 *
 * NiceHash treats price increases and decreases asymmetrically:
 *   - DECREASE: capped at a MAXIMUM downward move per edit
 *     (`maxPriceDecreaseStepSatPerPhDay`, default 200 sat/PH/day) AND no more
 *     often than once per `priceDecreaseCooldownMs` (default 10 minutes). A
 *     decrease larger than the cap is rejected by NiceHash with
 *     error 5063 "Order price change is too big".
 *   - INCREASE: unrestricted - any amount, any time, no cooldown, no cap.
 *
 * IMPORTANT (the bug this file used to have): the per-edit amount is a
 * MAXIMUM, not a minimum granularity. The old logic snapped a decrease UP to
 * the largest whole multiple of the step at-or-above the target, so a target
 * far below the current price produced a single multi-step drop (e.g. 600 or
 * 3200 sat) that busted NiceHash's cap and 5063'd every tick. We now take AT
 * MOST ONE cap-sized step toward the target per edit and walk the price down
 * over successive cooldown windows. Reaching a distant target therefore takes
 * several edits (one per cooldown), which is exactly how NiceHash intends it.
 *
 * The cap value was confirmed live: a manual -200 sat/PH/day (0.4921 ->
 * 0.4901 BTC/EH/day) edit was accepted, while the daemon's larger multi-step
 * decreases were rejected. If NiceHash changes the cap for this market, only
 * the default (a config knob) changes - the logic is unit-agnostic.
 *
 * (For contrast, Braiins has a price-decrease cooldown too - read
 * dynamically from `min_bid_price_decrease_period_s` in its market
 * settings - but no per-edit cap. That path lives in the daemon's gate.ts and
 * is unaffected by this module.)
 *
 * Unit note: everything here is sat/PH/day. The order is quoted in
 * BTC/EH/day on NiceHash; 200 sat/PH/day == 0.002 BTC/EH/day.
 */

export const NICEHASH_DEFAULT_MAX_PRICE_DECREASE_STEP_SAT_PER_PH_DAY = 200;
export const NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS = 10 * 60_000;

/**
 * Back-compat alias for the renamed constant (was "MIN", is really the MAX
 * per-edit cap). Kept so any external import keeps resolving.
 */
export const NICEHASH_DEFAULT_MIN_PRICE_DECREASE_STEP_SAT_PER_PH_DAY =
  NICEHASH_DEFAULT_MAX_PRICE_DECREASE_STEP_SAT_PER_PH_DAY;

/** Below this many sat/PH/day, a price move is treated as no change (float noise). */
const NOOP_EPSILON = 1e-6;

export interface NicehashEditConstraints {
  /**
   * Maximum downward move allowed in a single edit, sat/PH/day. Default 200.
   * A larger requested decrease is clamped to this (and finished over later
   * ticks); NiceHash 5063s anything above it.
   */
  readonly maxPriceDecreaseStepSatPerPhDay?: number;
  /**
   * @deprecated Old name for the same knob (it was mislabelled a minimum).
   * Still honoured if set, so existing callers/config keep working.
   */
  readonly minPriceDecreaseStepSatPerPhDay?: number;
  /** Minimum time between successive price decreases, ms. Default 10 min. */
  readonly priceDecreaseCooldownMs?: number;
}

export type NicehashEditKind = 'NONE' | 'INCREASE' | 'DECREASE';

export type NicehashEditDenialReason = 'NO_CHANGE' | 'DECREASE_COOLDOWN';

export interface NicehashPriceEditDecision {
  readonly allowed: boolean;
  readonly kind: NicehashEditKind;
  /**
   * The price to actually submit, sat/PH/day. For a decrease this is the
   * current price minus at most one cap-sized step, never below the desired
   * price (so we approach the target without overshooting). null when no edit
   * should be sent.
   */
  readonly submitPriceSatPerPhDay: number | null;
  readonly denialReason: NicehashEditDenialReason | null;
  /** True when a decrease was clamped by the cap (more steps still needed). */
  readonly clampedByCap: boolean;
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

/**
 * Pull the EXACT remaining decrease-cooldown, in seconds, out of a rejected
 * NiceHash edit response body. NiceHash rejects a too-soon price decrease with
 * a message like:
 *
 *   "Order price decreased not allowed within 10 minutes of last price change.
 *    Seconds till available: 544"
 *
 * This is the only place NiceHash reveals the precise time left (the order
 * object carries no last-price-change timestamp), and it also accounts for a
 * MANUAL price edit the operator made outside the daemon - which resets
 * NiceHash's server-side timer without the daemon ever seeing it. Returns null
 * when the body isn't a cooldown rejection.
 */
export function parseNicehashDecreaseCooldownSeconds(body: unknown): number | null {
  const errs = (body as { errors?: Array<{ code?: number; message?: unknown }> } | null)?.errors;
  if (!Array.isArray(errs)) return null;
  for (const e of errs) {
    const msg = typeof e?.message === 'string' ? e.message : '';
    const m = msg.match(/seconds till available:\s*(\d+)/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

export function evaluateNicehashPriceEdit(
  args: EvaluateNicehashPriceEditArgs,
): NicehashPriceEditDecision {
  const step =
    args.constraints?.maxPriceDecreaseStepSatPerPhDay ??
    args.constraints?.minPriceDecreaseStepSatPerPhDay ??
    NICEHASH_DEFAULT_MAX_PRICE_DECREASE_STEP_SAT_PER_PH_DAY;
  const cooldownMs =
    args.constraints?.priceDecreaseCooldownMs ?? NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS;

  const delta = args.desiredPriceSatPerPhDay - args.currentPriceSatPerPhDay;

  if (Math.abs(delta) < NOOP_EPSILON) {
    return {
      allowed: false,
      kind: 'NONE',
      submitPriceSatPerPhDay: null,
      denialReason: 'NO_CHANGE',
      clampedByCap: false,
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
      clampedByCap: false,
      reason: `increase +${Math.round(delta)} sat/PH/day (unrestricted)`,
    };
  }

  // DECREASE - cooldown first, then clamp to at most one cap-sized step.
  if (args.lastDecreaseAtMs !== null && args.now - args.lastDecreaseAtMs < cooldownMs) {
    const waitMin = (cooldownMs - (args.now - args.lastDecreaseAtMs)) / 60_000;
    return {
      allowed: false,
      kind: 'DECREASE',
      submitPriceSatPerPhDay: null,
      denialReason: 'DECREASE_COOLDOWN',
      clampedByCap: false,
      reason: `decrease blocked: ${waitMin.toFixed(1)} min left on 10-min decrease cooldown`,
    };
  }

  const magnitude = -delta; // positive amount we want to come down by
  // Take at most ONE cap-sized step toward the target - never a multiple, or
  // NiceHash 5063s ("price change is too big"). If the target is within one
  // step, go straight to it; otherwise clamp and finish on later ticks.
  const thisStep = Math.min(magnitude, step);
  const submit = args.currentPriceSatPerPhDay - thisStep;
  const clampedByCap = magnitude > step + NOOP_EPSILON;
  return {
    allowed: true,
    kind: 'DECREASE',
    submitPriceSatPerPhDay: submit,
    denialReason: null,
    clampedByCap,
    reason: clampedByCap
      ? `decrease -${Math.round(thisStep)} sat/PH/day (capped at ${step}/edit; desired -${Math.round(
          magnitude,
        )}, more steps to follow)`
      : `decrease -${Math.round(thisStep)} sat/PH/day (within ${step}/edit cap)`,
  };
}
