/**
 * B6: slab-based sizing, applied to whichever venue is currently cheapest
 * (the single-active winner) - replacing the Braiins-only cheap mode.
 *
 * The operator's model: how much hashrate you want depends on how expensive
 * it is relative to break-even. Cheap hashrate is worth buying in bulk;
 * hashrate above break-even loses money and should not be bought at all.
 *
 * The comparison is `effective price INCLUDING fees` as a percentage of
 * hashprice. Fees matter because NiceHash charges its marketplace fee on top
 * of the order price, so a "49,500" NiceHash order really costs ~51,000 at a
 * 3% fee - which can be the difference between the 101% slab and the 103%
 * slab.
 *
 * Default table (operator-supplied 2026-07-27):
 *     < 100%       -> 3 PH      (below break-even: buy big)
 *     100 - 101%   -> 2.5 PH
 *     101 - 102%   -> 2 PH
 *     102 - 103%   -> 1.5 PH
 *     103 - 104%   -> 1 PH
 *     > 104%       -> PARK      (uneconomic: buy nothing)
 *
 * Slabs are operator-editable as JSON in `config.cheap_mode_slabs`. Each
 * entry is `{ maxPct, targetPh }`, matched in ascending `maxPct` order - the
 * first entry whose `maxPct` is greater than the price ratio wins.
 * `targetPh: 0` means PARK. A final open-ended entry is implied: anything
 * above the last `maxPct` parks.
 */

export interface PriceSlab {
  /** Upper bound (exclusive) of this slab, as a % of hashprice. */
  readonly maxPct: number;
  /** Target hashrate (PH/s) for this slab. 0 = park (buy nothing). */
  readonly targetPh: number;
}

export const DEFAULT_PRICE_SLABS: readonly PriceSlab[] = [
  { maxPct: 100, targetPh: 3 },
  { maxPct: 101, targetPh: 2.5 },
  { maxPct: 102, targetPh: 2 },
  { maxPct: 103, targetPh: 1.5 },
  { maxPct: 104, targetPh: 1 },
];

export interface SlabDecision {
  /** Target hashrate for this tick, PH/s. 0 when the market is uneconomic. */
  readonly targetPh: number;
  /** True when the price is above every slab - buy nothing, park both venues. */
  readonly park: boolean;
  /** Fee-inclusive price as a % of hashprice, for logging / the dashboard. */
  readonly pricePctOfHashprice: number | null;
  readonly reason: string;
}

/**
 * Parse the operator's JSON slab table. Invalid / empty input falls back to
 * the defaults rather than throwing - a malformed config must never stop the
 * daemon trading, and the defaults are the operator's own table.
 */
export function parseSlabs(json: string | null | undefined): readonly PriceSlab[] {
  if (!json || json.trim() === '') return DEFAULT_PRICE_SLABS;
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_PRICE_SLABS;
    const slabs = raw
      .map((r) => {
        const o = r as { maxPct?: unknown; targetPh?: unknown };
        const maxPct = Number(o.maxPct);
        const targetPh = Number(o.targetPh);
        if (!Number.isFinite(maxPct) || !Number.isFinite(targetPh) || targetPh < 0) return null;
        return { maxPct, targetPh } satisfies PriceSlab;
      })
      .filter((s): s is PriceSlab => s !== null)
      .sort((a, b) => a.maxPct - b.maxPct);
    return slabs.length > 0 ? slabs : DEFAULT_PRICE_SLABS;
  } catch {
    return DEFAULT_PRICE_SLABS;
  }
}

/**
 * Pick the target hashrate for this tick.
 *
 * @param effectivePriceSatPerPhDay the ACTIVE venue's price we'd actually
 *        post, BEFORE fees (fees are applied here so callers pass the raw
 *        bid).
 * @param feePct the active venue's marketplace fee (%), added on top.
 * @param hashpriceSatPerPhDay break-even from Ocean. null => cannot evaluate.
 */
export function decideSlabTarget(inputs: {
  readonly effectivePriceSatPerPhDay: number | null;
  readonly feePct: number;
  readonly hashpriceSatPerPhDay: number | null;
  readonly slabs: readonly PriceSlab[];
  /** Fallback when the price or hashprice is unknown this tick. */
  readonly fallbackTargetPh: number;
}): SlabDecision {
  const { effectivePriceSatPerPhDay, hashpriceSatPerPhDay, slabs } = inputs;
  if (
    effectivePriceSatPerPhDay === null ||
    hashpriceSatPerPhDay === null ||
    !(hashpriceSatPerPhDay > 0)
  ) {
    // Unknown price or hashprice: hold the configured target rather than
    // guessing. Refusing to trade on a missing hashprice is handled upstream
    // by the dynamic-cap rule; this is only about SIZING.
    return {
      targetPh: inputs.fallbackTargetPh,
      park: false,
      pricePctOfHashprice: null,
      reason: 'slab sizing unavailable (price or hashprice unknown) - using configured target',
    };
  }

  const feeInclusive = effectivePriceSatPerPhDay * (1 + inputs.feePct / 100);
  const pct = (feeInclusive / hashpriceSatPerPhDay) * 100;

  for (const slab of slabs) {
    if (pct < slab.maxPct) {
      return {
        targetPh: slab.targetPh,
        park: slab.targetPh <= 0,
        pricePctOfHashprice: pct,
        reason:
          slab.targetPh > 0
            ? `slab: ${pct.toFixed(1)}% of hashprice (fees in) -> target ${slab.targetPh} PH/s`
            : `slab: ${pct.toFixed(1)}% of hashprice (fees in) -> park (uneconomic)`,
      };
    }
  }

  // Above every slab -> uneconomic, buy nothing.
  return {
    targetPh: 0,
    park: true,
    pricePctOfHashprice: pct,
    reason: `slab: ${pct.toFixed(1)}% of hashprice (fees in) is above the top slab - park (uneconomic)`,
  };
}
