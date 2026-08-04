/**
 * B2: persistent cache of terminal NiceHash orders (CANCELLED / COMPLETED /
 * DEAD / EXPIRED).
 *
 * A terminal order's `payedAmount` is final, so we store it once and
 * `NiceHashSpendService.getLifetimeSpend()` starts each refresh from this
 * cached running total, adding only newly-terminal orders on top.
 *
 * The currently active order is NOT cached here - its `payedAmount`
 * increases as NiceHash bills it, and the service always re-reads it live
 * from the order snapshot.
 *
 * Deliberately mirrors state/repos/closed_bids_cache.ts (the Braiins-side
 * equivalent) field-for-field.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../types.js';

export interface NicehashOrderCacheRow {
  nicehash_order_id: string;
  payed_amount_sat: number;
  first_seen_at: number;
  last_seen_at: number;
}

export class NicehashOrdersCacheRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Upsert a terminal order by order id. On conflict we refresh
   * `payed_amount_sat` (in case NiceHash ever publishes a slightly
   * different final figure after the status flips) and bump `last_seen_at`.
   */
  async upsert(
    row: { nicehash_order_id: string; payed_amount_sat: number },
    now: number,
  ): Promise<void> {
    await this.db
      .insertInto('nicehash_orders_cache')
      .values({
        nicehash_order_id: row.nicehash_order_id,
        payed_amount_sat: row.payed_amount_sat,
        first_seen_at: now,
        last_seen_at: now,
      })
      .onConflict((oc) =>
        oc.column('nicehash_order_id').doUpdateSet({
          payed_amount_sat: row.payed_amount_sat,
          last_seen_at: now,
        }),
      )
      .execute();
  }

  /** Total payed sat across every cached terminal order. */
  async sumPayedAmountSat(): Promise<number> {
    const result = await this.db
      .selectFrom('nicehash_orders_cache')
      .select(sql<number>`COALESCE(SUM(payed_amount_sat), 0)`.as('total'))
      .executeTakeFirst();
    return Number(result?.total ?? 0);
  }

  /** Returns the set of cached order IDs for fast membership checks. */
  async allIds(): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('nicehash_orders_cache')
      .select('nicehash_order_id')
      .execute();
    return new Set(rows.map((r) => r.nicehash_order_id));
  }

  /** Row count - mostly for diagnostics / tests. */
  async count(): Promise<number> {
    const result = await this.db
      .selectFrom('nicehash_orders_cache')
      .select(sql<number>`COUNT(*)`.as('count'))
      .executeTakeFirst();
    return Number(result?.count ?? 0);
  }

  /**
   * Nuke every row. Exposed so the operator can force a full re-fetch when
   * they suspect the cache has gone stale.
   */
  async clear(): Promise<void> {
    await this.db.deleteFrom('nicehash_orders_cache').execute();
  }
}
