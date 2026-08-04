/**
 * NiceHash order maintenance - the NiceHash analogue of decide.ts, scoped to
 * a single long-lived order.
 *
 * TWO CONFIRMED NICEHASH MECHANICS THAT SHAPE THIS (operator-confirmed
 * 2026-07-22):
 *
 * 1. New-order fee. Placing a NEW NiceHash order costs ~1,000 sats;
 *    "refilling" an existing order's budget is free. So we keep ONE order
 *    alive and REFILL it as it drains, rather than letting it expire and
 *    recreating (Braiins, by contrast, makes new orders for free).
 *
 * 2. No pause. A NiceHash order can't be paused. To idle it when Braiins
 *    becomes the better venue, we DROP ITS PRICE BELOW THE FILL LINE (a
 *    decrease) so it stops getting matched and sits at zero cost while
 *    staying alive - "parking". Reactivating is just RAISING the price back
 *    above the fill line, and increases are unrestricted, so re-entry is
 *    instant and free. We therefore NEVER cancel on a routine provider
 *    switch - only park. CANCEL is reserved for a hard teardown (operator
 *    disables NiceHash entirely).
 *
 * Asymmetry with Braiins on switch-away: the Braiins loser is cancelled
 * (recreating is free there); the NiceHash loser is parked (recreating costs
 * the fee here).
 *
 * Price edits - park included - go through `evaluateNicehashPriceEdit`, so
 * they obey NiceHash's per-edit decrease CAP (max ~200 sat/PH/day per edit;
 * a bigger drop 5063s "price change is too big") plus the 10-min decrease
 * cooldown (increases are free and instant). A decrease toward a distant
 * target therefore lands one cap-sized step at a time over successive
 * cooldown windows; until it converges the order keeps filling at the
 * higher price. That window is bounded and the provider switch itself is
 * already gated by the sustained window.
 *
 * Pure and side-effect free: returns an ordered list of actions the executor
 * carries out (REFILL and EDIT_PRICE can both fire on one tick). In DRY-RUN
 * they're logged, not sent.
 */

import {
  evaluateNicehashPriceEdit,
  NICEHASH_DEFAULT_MAX_PRICE_DECREASE_STEP_SAT_PER_PH_DAY,
  type NicehashEditConstraints,
} from '@hashrate-autopilot/nicehash-client';

import { isParked } from './park.js';

/**
 * NiceHash's minimum BTC per order / per refill (their Buy panel shows
 * "Min: 0.001"). Config allows 0 for these amounts, and 0 was silently POSTed
 * as `amountBtc: 0`, which NiceHash rejects - the real cause of the 2026-07-30
 * "daemon can't create a new order" incident (the operator had left NiceHash
 * order budget at 0). Catch it here with an operator-readable reason instead of
 * emitting an API call that can only ever 400.
 */
export const NICEHASH_MIN_ORDER_BTC = 0.001;

export type NicehashOrderActionKind =
  | 'CREATE'
  | 'REFILL'
  | 'EDIT_PRICE'
  | 'PARK'
  | 'CANCEL'
  | 'NONE';

export interface NicehashOrderSnapshot {
  readonly exists: boolean;
  readonly orderId: string | null;
  readonly currentPriceSatPerPhDay: number | null;
  /** Remaining (unspent) budget on the order, BTC. null if unknown. */
  readonly remainingBtc: number | null;
  /** When we last DECREASED this order's price, ms epoch. null if never. */
  readonly lastDecreaseAtMs: number | null;
}

export interface DecideNicehashInputs {
  /** Is NiceHash the selected active provider this tick? */
  readonly providerActive: boolean;
  /** Fill line + overpay, sat/PH/day. null when NiceHash is unpriceable this tick. */
  readonly desiredPriceSatPerPhDay: number | null;
  /**
   * Where to drop the price to when parking (must be BELOW the current fill
   * line so the order stops matching), sat/PH/day. Typically fill line minus
   * a safety margin, floored at NiceHash's minimum. null = can't compute a
   * safe park price this tick (hold).
   */
  readonly parkPriceSatPerPhDay: number | null;
  /**
   * Hard teardown: cancel the order outright (operator disabled NiceHash, or
   * we're abandoning it). Distinct from a routine switch-away, which parks.
   */
  readonly teardown?: boolean;
  readonly order: NicehashOrderSnapshot;
  /** Refill when remaining budget falls below this, BTC. */
  readonly refillThresholdBtc: number;
  /** How much to top up on a REFILL, BTC. */
  readonly refillAmountBtc: number;
  /** Initial budget when CREATING the first order, BTC. */
  readonly createAmountBtc: number;
  readonly now: number;
  readonly editConstraints?: NicehashEditConstraints;
  /**
   * Minimum downward gap (sat/PH/day) before a tracking DECREASE is worth
   * doing. Because every decrease locks out further decreases for 10 minutes
   * regardless of size, a sub-cap nudge (e.g. -21) wastes the whole cooldown.
   * We only lower when the order is at least this far above the target, so each
   * cooldown buys a (near-)full step; smaller gaps ride as minor overpay until
   * they grow. Does NOT apply to PARK (that must reach below the fill line).
   * Defaults to the per-edit cap (200 sat/PH/day).
   */
  readonly decreaseDeadbandSatPerPhDay?: number;
  /**
   * The overpay cushion baked into `desiredPriceSatPerPhDay` (sat/PH/day), used
   * to throttle INCREASES. On NiceHash EVERY price change - increases included -
   * starts the 10-minute decrease lockout, so tracking a rising fill line with a
   * tiny +N every tick would permanently block our decreases. Instead we hold an
   * increase while the order is still comfortably above the fill line (filling on
   * the overpay cushion) and only RAISE once it has fallen to/below the fill line
   * (desired - overpay), then jump straight back to desired for fresh headroom.
   * When omitted/0 we fall back to always raising (legacy behaviour).
   */
  readonly overpaySatPerPhDay?: number;
  /**
   * #55: the NiceHash book is RATIONED this tick (no deep-liquidity block). When
   * true we do NOT raise the price - chasing a rising fill line into thin scraps
   * only burns the 10-min lockout and pays more for hashrate that isn't there.
   * The order keeps delivering whatever it fills at its current price and Braiins
   * supplements the shortfall (#56). DECREASES and REFILLS are unaffected.
   */
  readonly rationed?: boolean;
}

export interface NicehashOrderAction {
  readonly kind: NicehashOrderActionKind;
  readonly orderId?: string;
  readonly submitPriceSatPerPhDay?: number;
  readonly amountBtc?: number;
  readonly reason: string;
}

export function decideNicehash(inputs: DecideNicehashInputs): readonly NicehashOrderAction[] {
  const { order } = inputs;

  // Hard teardown - the only path that cancels a NiceHash order.
  if (inputs.teardown) {
    if (order.exists && order.orderId) {
      return [{ kind: 'CANCEL', orderId: order.orderId, reason: 'NiceHash teardown - cancel order' }];
    }
    return [{ kind: 'NONE', reason: 'NiceHash teardown; no order to cancel' }];
  }

  // NiceHash is not the active provider -> PARK (drop below fill line), never
  // cancel. Parking idles the order at zero cost while keeping it alive for a
  // free, instant reactivation later.
  if (!inputs.providerActive) {
    if (!order.exists) {
      return [{ kind: 'NONE', reason: 'NiceHash inactive; no order to park' }];
    }
    if (inputs.parkPriceSatPerPhDay === null || order.currentPriceSatPerPhDay === null) {
      return [{ kind: 'NONE', reason: 'NiceHash inactive but park price unknown this tick - hold' }];
    }
    // Already at/below the park price -> idle, nothing to do.
    if (isParked(order.currentPriceSatPerPhDay, inputs.parkPriceSatPerPhDay)) {
      return [{ kind: 'NONE', reason: 'NiceHash order already parked below the fill line' }];
    }
    const edit = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: order.currentPriceSatPerPhDay,
      desiredPriceSatPerPhDay: inputs.parkPriceSatPerPhDay,
      lastDecreaseAtMs: order.lastDecreaseAtMs,
      now: inputs.now,
      ...(inputs.editConstraints ? { constraints: inputs.editConstraints } : {}),
    });
    if (edit.allowed && edit.submitPriceSatPerPhDay !== null) {
      return [
        {
          kind: 'PARK',
          ...(order.orderId ? { orderId: order.orderId } : {}),
          submitPriceSatPerPhDay: edit.submitPriceSatPerPhDay,
          reason: `park below fill line to idle at zero cost (no cancel/recreate fee): ${edit.reason}`,
        },
      ];
    }
    // The parking decrease is blocked (10-min cooldown) - the order keeps
    // filling at its old price until the cooldown clears; retry next tick.
    return [{ kind: 'NONE', reason: `park pending: ${edit.reason}` }];
  }

  // NiceHash active but no live order - create the (only) one. Pays the
  // ~1,000-sat new-order fee; unavoidable on first entry.
  if (!order.exists) {
    if (inputs.desiredPriceSatPerPhDay === null) {
      return [{ kind: 'NONE', reason: 'NiceHash active but unpriceable this tick - skip create' }];
    }
    if (inputs.createAmountBtc < NICEHASH_MIN_ORDER_BTC) {
      return [
        {
          kind: 'NONE',
          reason:
            `cannot create: NiceHash order budget is ${inputs.createAmountBtc} BTC, below ` +
            `NiceHash's ${NICEHASH_MIN_ORDER_BTC} BTC minimum. Set "NiceHash order budget" ` +
            `in Config to at least ${NICEHASH_MIN_ORDER_BTC} BTC.`,
        },
      ];
    }
    return [
      {
        kind: 'CREATE',
        submitPriceSatPerPhDay: inputs.desiredPriceSatPerPhDay,
        amountBtc: inputs.createAmountBtc,
        reason: `create sole NiceHash order at ${Math.round(inputs.desiredPriceSatPerPhDay)} sat/PH/day (new-order fee applies)`,
      },
    ];
  }

  const actions: NicehashOrderAction[] = [];

  // Keep the existing order ALIVE via refill - the whole point of not letting
  // it expire (a replacement would re-pay the new-order fee). A parked order
  // isn't spending, so this naturally won't fire until it's active again.
  if (order.remainingBtc !== null && order.remainingBtc < inputs.refillThresholdBtc) {
    if (inputs.refillAmountBtc < NICEHASH_MIN_ORDER_BTC) {
      actions.push({
        kind: 'NONE',
        reason:
          `cannot refill: refill amount ${inputs.refillAmountBtc} BTC is below NiceHash's ` +
          `${NICEHASH_MIN_ORDER_BTC} BTC minimum - raise "NiceHash refill amount" in Config.`,
      });
    } else {
    actions.push({
      kind: 'REFILL',
      ...(order.orderId ? { orderId: order.orderId } : {}),
      amountBtc: inputs.refillAmountBtc,
      reason: `remaining ${order.remainingBtc.toFixed(8)} BTC < ${inputs.refillThresholdBtc.toFixed(8)} threshold - refill (avoids new-order fee)`,
    });
    }
  }

  // Track the fill line + overpay via an in-place price edit, honoring the
  // NiceHash step + cooldown. This is also the REACTIVATION path: if the order
  // was parked (price below fill), moving it back up to desired is an
  // unrestricted increase, so it re-enters instantly and for free. Never a
  // cancel+recreate for a price move.
  if (inputs.desiredPriceSatPerPhDay !== null && order.currentPriceSatPerPhDay !== null) {
    const current = order.currentPriceSatPerPhDay;
    const desired = inputs.desiredPriceSatPerPhDay;
    const decreaseDeadband =
      inputs.decreaseDeadbandSatPerPhDay ??
      NICEHASH_DEFAULT_MAX_PRICE_DECREASE_STEP_SAT_PER_PH_DAY;
    const overpay = inputs.overpaySatPerPhDay ?? 0;
    const fillLine = desired - overpay; // desired = fill line + overpay

    // Every price change (up OR down) starts NiceHash's 10-min decrease
    // lockout, so we edit as seldom as possible:
    //   * DECREASE only when overpaying by >= the deadband (one capped step),
    //     so a cooldown is never spent on a sub-cap nudge.
    //   * INCREASE only when the order has fallen to/below the fill line (about
    //     to stop, or already not, delivering) - then jump straight back to
    //     desired for fresh headroom. While still above the fill line we hold,
    //     so a rising fill line doesn't fire a tiny per-tick increase that would
    //     keep the decrease lockout permanently reset. (overpay <= 0 -> unknown
    //     cushion, fall back to always raising.)
    const decreaseTarget = desired;

    let shouldEdit = false;
    if (current - decreaseTarget >= decreaseDeadband) {
      // #B (revised): step DOWN normally, one capped 200 step per cooldown.
      // v1.18.14 briefly suppressed decreases while delivering on target, to stop
      // the Jul-27 "trim -200 at full delivery -> collapse to 0.24 PH" incident.
      // But the true cause there was the fill line anchoring on scraps, which #E
      // fixes at source (per-order dust floor + cumulative bottom skip). With a
      // trustworthy, noise-filtered fill line there is no reason to sit ~900
      // sat/PH/day above it - that is pure overpay. So decreases track normally
      // again; the capped step + 10-min cooldown already bound the downside, and
      // the increase path recovers instantly if a step goes too far.
      shouldEdit = true;
    } else if (current < desired) {
      // #55: never chase the price UP while the market is rationed - the extra
      // supply isn't there, so a raise just burns the lockout and overpays.
      shouldEdit = !inputs.rationed && (overpay <= 0 || current <= fillLine);
    }

    if (shouldEdit) {
      const edit = evaluateNicehashPriceEdit({
        currentPriceSatPerPhDay: current,
        desiredPriceSatPerPhDay: desired,
        lastDecreaseAtMs: order.lastDecreaseAtMs,
        now: inputs.now,
        ...(inputs.editConstraints ? { constraints: inputs.editConstraints } : {}),
      });
      if (edit.allowed && edit.submitPriceSatPerPhDay !== null) {
        actions.push({
          kind: 'EDIT_PRICE',
          ...(order.orderId ? { orderId: order.orderId } : {}),
          submitPriceSatPerPhDay: edit.submitPriceSatPerPhDay,
          reason: edit.reason,
        });
      }
    }
  }

  if (actions.length === 0) {
    return [{ kind: 'NONE', reason: 'NiceHash order healthy and on-price' }];
  }
  return actions;
}
