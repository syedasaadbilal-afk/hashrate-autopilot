/**
 * Provider selection for the dual-marketplace controller.
 *
 * The autopilot rents from exactly ONE marketplace at a time (Braiins or
 * NiceHash) and routes it to the same OCEAN/DATUM pool. This pure function
 * decides which marketplace should be active on a given tick, given the
 * effective bid price we'd post on each (fillable/fill-line + overpay, in
 * sat/PH/day) and the operator's switch policy.
 *
 * Rules (operator-specified):
 *   - Braiins is the incumbent / default active provider.
 *   - NiceHash is "preferred by price" only when it is strictly MORE than
 *     `switchThresholdPct` cheaper than Braiins (default 3.25%). At or below
 *     the threshold, Braiins is preferred - so the band [0, 3.25%] of
 *     NiceHash advantage is a no-switch zone.
 *   - A switch (either direction) only happens after the challenger has been
 *     continuously preferred for `sustainedWindowMinutes`. This is the same
 *     "every tick in the window must pass" hysteresis the cheap-mode
 *     sustained window uses (#160) - it stops the controller flapping
 *     between exchanges (each flip is a cancel-here / recreate-there cycle
 *     with real downtime).
 *
 * Missing data: if EITHER price is unknown this tick (an exchange's API/order
 * book was unreachable), the threshold comparison can't be made, so we hold
 * the active provider and RESET the challenger timer - a data gap breaks the
 * "continuously preferred" window, exactly as a missed tick breaks cheap-mode.
 * Conservative on purpose: never switch marketplaces on incomplete evidence.
 *
 * This function decides *preference only*. It does not cancel or place
 * orders - the tick driver reads `activeProvider` and drives the per-provider
 * decide()/execute() for the winner (and the cancel-the-loser handover)
 * downstream, gated by run mode exactly like every other mutation.
 */

export type Provider = 'BRAIINS' | 'NICEHASH';

export interface ProviderPriceInputs {
  /** Effective bid we'd post on Braiins (fillable_ask + overpay), sat/PH/day. null if unavailable this tick. */
  readonly braiinsSatPerPhDay: number | null;
  /** Effective bid we'd post on NiceHash (lowest filling + overpay), sat/PH/day. null if unavailable this tick. */
  readonly nicehashSatPerPhDay: number | null;
}

export interface ProviderSelectConfig {
  /** NiceHash must be strictly more than this % cheaper than Braiins to be preferred. Default 3.25. */
  readonly switchThresholdPct: number;
  /** Challenger must stay continuously preferred this many minutes before an actual switch. 0 = switch immediately. */
  readonly sustainedWindowMinutes: number;
}

export interface ProviderSelectState {
  readonly activeProvider: Provider;
  /** When the non-active (challenger) provider first became continuously preferred, or null. */
  readonly challengerReadySince: number | null;
}

export interface ProviderSelectResult {
  readonly activeProvider: Provider;
  readonly challengerReadySince: number | null;
  readonly switched: boolean;
  /** This tick's price-preferred provider, or null when it couldn't be decided (missing price). */
  readonly preferredByPrice: Provider | null;
  /** NiceHash's % advantage vs Braiins this tick (positive = cheaper), or null. */
  readonly nicehashAdvantagePct: number | null;
  readonly reason: string;
}

const OTHER: Record<Provider, Provider> = { BRAIINS: 'NICEHASH', NICEHASH: 'BRAIINS' };

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

export function selectProvider(
  prices: ProviderPriceInputs,
  config: ProviderSelectConfig,
  prev: ProviderSelectState,
  now: number,
): ProviderSelectResult {
  const { braiinsSatPerPhDay: braiins, nicehashSatPerPhDay: nicehash } = prices;

  // Can't compare without both prices - hold the active provider, reset the
  // challenger timer (a data gap breaks the continuously-preferred window).
  if (braiins === null || nicehash === null || braiins <= 0) {
    const missing =
      braiins === null || braiins <= 0
        ? nicehash === null
          ? 'both prices'
          : 'Braiins price'
        : 'NiceHash price';
    return {
      activeProvider: prev.activeProvider,
      challengerReadySince: null,
      switched: false,
      preferredByPrice: null,
      nicehashAdvantagePct: null,
      reason: `hold ${prev.activeProvider}: ${missing} unavailable this tick`,
    };
  }

  const nicehashAdvantagePct = ((braiins - nicehash) / braiins) * 100;
  const nicehashPreferred = nicehashAdvantagePct > config.switchThresholdPct;
  const preferredByPrice: Provider = nicehashPreferred ? 'NICEHASH' : 'BRAIINS';

  // Active provider is still the price-preferred one: nothing to do, clear timer.
  if (preferredByPrice === prev.activeProvider) {
    return {
      activeProvider: prev.activeProvider,
      challengerReadySince: null,
      switched: false,
      preferredByPrice,
      nicehashAdvantagePct,
      reason:
        `keep ${prev.activeProvider} (NiceHash ${fmtPct(nicehashAdvantagePct)} vs ` +
        `${fmtPct(config.switchThresholdPct)} threshold)`,
    };
  }

  // Challenger is price-preferred - run the sustained-window gate.
  const challengerReadySince = prev.challengerReadySince ?? now;
  const elapsedMs = now - challengerReadySince;
  const windowMs = config.sustainedWindowMinutes * 60_000;
  const challenger = OTHER[prev.activeProvider];

  if (elapsedMs >= windowMs) {
    return {
      activeProvider: challenger,
      challengerReadySince: null,
      switched: true,
      preferredByPrice,
      nicehashAdvantagePct,
      reason:
        `switch ${prev.activeProvider} → ${challenger}: ${challenger} preferred for ` +
        `${(elapsedMs / 60_000).toFixed(1)}m ≥ ${config.sustainedWindowMinutes}m window ` +
        `(NiceHash ${fmtPct(nicehashAdvantagePct)})`,
    };
  }

  return {
    activeProvider: prev.activeProvider,
    challengerReadySince,
    switched: false,
    preferredByPrice,
    nicehashAdvantagePct,
    reason:
      `hold ${prev.activeProvider}: ${challenger} preferred ${(elapsedMs / 60_000).toFixed(1)}m / ` +
      `${config.sustainedWindowMinutes}m window (NiceHash ${fmtPct(nicehashAdvantagePct)})`,
  };
}
