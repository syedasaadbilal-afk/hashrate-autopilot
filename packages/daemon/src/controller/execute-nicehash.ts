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

import type { RunMode } from '@hashrate-autopilot/shared';

import type { NicehashOrderAction } from './decide-nicehash.js';
import type { NiceHashLiveParams, NiceHashService } from '../services/nicehash-service.js';

export interface ExecuteNicehashResult {
  readonly kind: NicehashOrderAction['kind'];
  readonly outcome: 'DRY_RUN' | 'EXECUTED' | 'FAILED' | 'SKIPPED';
  readonly note: string;
}

export async function executeNicehash(
  svc: NiceHashService,
  actions: readonly NicehashOrderAction[],
  runMode: RunMode,
  params: NiceHashLiveParams,
  targetPh: number,
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
            targetPh,
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
          await svc.editOrderPrice(params, a.orderId!, a.submitPriceSatPerPhDay!, targetPh);
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
      console.warn(`[nicehash] LIVE ${a.kind} FAILED: ${msg}`);
      results.push({ kind: a.kind, outcome: 'FAILED', note: msg });
    }
  }

  return results;
}
