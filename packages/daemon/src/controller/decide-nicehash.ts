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
 * they obey the 200 sat/PH/day decrease step + 10-min decrease cooldown
 * (increases are free). A parking decrease can therefore be delayed up to the
 * cooldown; until it lands the order keeps filling at its old price. That
 * window is bounded and the provider switch itself is already gated by the
 * sustained window.
 *
 * Pure and side-effect free: returns an ordered list of actions the executor
 * carries out (REFILL and EDIT_PRICE can both fire on one tick). In DRY-RUN
 * they're logged, not sent.
 */

import {
  evaluateNicehashPriceEdit,
  type NicehashEditConstraints,
} from '@hashrate-autopilot/nicehash-client';

import { isParked } from './park.js';

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
    actions.push({
      kind: 'REFILL',
      ...(order.orderId ? { orderId: order.orderId } : {}),
      amountBtc: inputs.refillAmountBtc,
      reason: `remaining ${order.remainingBtc.toFixed(8)} BTC < ${inputs.refillThresholdBtc.toFixed(8)} threshold - refill (avoids new-order fee)`,
    });
  }

  // Track the fill line + overpay via an in-place price edit, honoring the
  // NiceHash step + cooldown. This is also the REACTIVATION path: if the order
  // was parked (price below fill), moving it back up to desired is an
  // unrestricted increase, so it re-enters instantly and for free. Never a
  // cancel+recreate for a price move.
  if (inputs.desiredPriceSatPerPhDay !== null && order.currentPriceSatPerPhDay !== null) {
    const edit = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: order.currentPriceSatPerPhDay,
      desiredPriceSatPerPhDay: inputs.desiredPriceSatPerPhDay,
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

  if (actions.length === 0) {
    return [{ kind: 'NONE', reason: 'NiceHash order healthy and on-price' }];
  }
  return actions;
}
