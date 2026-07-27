/**
 * Executes the NiceHash order actions from decideNicehash, gated by the SAME
 * run_mode the Braiins side uses:
 *   - DRY_RUN / PAUSED: log "would <action>" and touch nothing (this is the
 *     validation mode - the logs show exactly what it parsed and would do
 *     against your real order, so you confirm correctness before LIVE).
 *   - LIVE: dispatch the mutation to NiceHash.
 *
 * Every action is wrapped so one failure (e.g. NiceHash rejecting a
 * too-soon price decrease) is logged and the tick continues. No local ledger:
 * NiceHash is reconciled fresh each tick via getMyOrder, so a failed or
 * partial mutation self-corrects next tick.
 */

import { parseNicehashDecreaseCooldownSeconds } from '@hashrate-autopilot/nicehash-client';
import type { RunMode } from '@hashrate-autopilot/shared';

import type { NicehashOrderAction } from './decide-nicehash.js';
import type { NiceHashLiveParams, NiceHashService } from '../services/nicehash-service.js';

export interface ExecuteNicehashResult {
  readonly kind: NicehashOrderAction['kind'];
  readonly outcome: 'DRY_RUN' | 'EXECUTED' | 'FAILED' | 'SKIPPED';
  readonly note: string;
  /**
   * When NiceHash rejected a price DECREASE because its 10-min cooldown hasn't
   * elapsed, the exact seconds it reports as remaining ("Seconds till
   * available: N"). The controller uses this to gate its own decreases so it
   * stops hammering the API and stays in sync with manual operator edits.
   */
  readonly cooldownSecondsLeft?: number;
}

export async function executeNicehash(
  svc: NiceHashService,
  actions: readonly NicehashOrderAction[],
  runMode: RunMode,
  params: NiceHashLiveParams,
  // The speed limit (PH/s) to set on CREATE and every EDIT. Normally the config
  // target (nicehash_target_hashrate_ph); the caller may pass a THROTTLED value
  // (e.g. 1 PH during a dislocation, #56) and restore it on normalisation.
  // NiceHash ACCEPTS limit decreases (confirmed live 2026-07-26: 2 PH -> 1 PH),
  // so we set the limit to what we actually want - the old "echo current limit
  // because NiceHash 400s a decrease" workaround was wrong (those 400s were the
  // price cap 5063 / decimals 2997, never the limit). Floor is 1 PH in 1 PH
  // steps; the caller keeps it whole and >= 1.
  desiredLimitPh: number,
): Promise<ExecuteNicehashResult[]> {
  const results: ExecuteNicehashResult[] = [];

  for (const a of actions) {
    if (a.kind === 'NONE') {
      results.push({ kind: a.kind, outcome: 'SKIPPED', note: a.reason });
      continue;
    }

    // Gate: only LIVE actually mutates. Mirrors Braiins' execute() DRY-RUN path.
    if (runMode !== 'LIVE') {
      console.info(`[nicehash] DRY-RUN would ${a.kind}: ${a.reason}`);
      results.push({ kind: a.kind, outcome: 'DRY_RUN', note: `would ${a.kind}: ${a.reason}` });
      continue;
    }

    try {
      switch (a.kind) {
        case 'CREATE': {
          const id = await svc.createOrder(
            params,
            a.submitPriceSatPerPhDay!,
            desiredLimitPh,
            a.amountBtc!,
          );
          console.info(`[nicehash] LIVE CREATE ok id=${id}: ${a.reason}`);
          results.push({ kind: a.kind, outcome: 'EXECUTED', note: `created ${id}` });
          break;
        }
        case 'REFILL': {
          await svc.refillOrder(a.orderId!, a.amountBtc!);
          console.info(`[nicehash] LIVE REFILL ok id=${a.orderId}: ${a.reason}`);
          results.push({ kind: a.kind, outcome: 'EXECUTED', note: `refilled ${a.orderId}` });
          break;
        }
        case 'EDIT_PRICE':
        case 'PARK': {
          // updatePriceAndLimit requires a limit; we set it to the desired limit
          // (config target, or a throttled value from the caller). Limit
          // decreases are accepted, so this also converges the order to the
          // configured target if it was created larger.
          await svc.editOrderPrice(params, a.orderId!, a.submitPriceSatPerPhDay!, desiredLimitPh);
          console.info(`[nicehash] LIVE ${a.kind} ok id=${a.orderId}: ${a.reason}`);
          results.push({ kind: a.kind, outcome: 'EXECUTED', note: `${a.kind} ${a.orderId}` });
          break;
        }
        case 'CANCEL': {
          await svc.cancelOrder(a.orderId!);
          console.info(`[nicehash] LIVE CANCEL ok id=${a.orderId}: ${a.reason}`);
          results.push({ kind: a.kind, outcome: 'EXECUTED', note: `cancelled ${a.orderId}` });
          break;
        }
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // NiceHashApiError carries the parsed response body - surface it so a 400
      // says WHY (e.g. limit decrease, price step) instead of just the status.
      const body = (err as { body?: unknown }).body;
      const detail = body !== undefined ? ` body=${JSON.stringify(body)}` : '';
      console.warn(`[nicehash] LIVE ${a.kind} FAILED: ${msg}${detail}`);
      // If it's the decrease-cooldown rejection, capture the EXACT seconds
      // NiceHash reports so the controller can hold future decreases precisely
      // (and pick up a manual operator edit that reset NiceHash's timer).
      const cooldownSecondsLeft = parseNicehashDecreaseCooldownSeconds(body);
      results.push({
        kind: a.kind,
        outcome: 'FAILED',
        note: `${msg}${detail}`,
        ...(cooldownSecondsLeft !== null ? { cooldownSecondsLeft } : {}),
      });
    }
  }

  return results;
}
