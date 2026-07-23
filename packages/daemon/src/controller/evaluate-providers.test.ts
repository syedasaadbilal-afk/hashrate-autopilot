import type { NiceHashOrderBookOrder } from '@hashrate-autopilot/nicehash-client';
import { describe, expect, it } from 'vitest';

import { evaluateProviders } from './evaluate-providers.js';
import type { ProviderSelectConfig, ProviderSelectState } from './provider-select.js';

const MF = 1e12; // SHA256 marketFactor (TH units)
const SWITCH: ProviderSelectConfig = { switchThresholdPct: 3.25, sustainedWindowMinutes: 10 };
const ON_BRAIINS: ProviderSelectState = { activeProvider: 'BRAIINS', challengerReadySince: null };
const T0 = 1_000_000_000_000;

function order(
  price: number,
  acceptedTh: number,
  market?: string,
): NiceHashOrderBookOrder {
  return {
    id: `o-${price}-${acceptedTh}`,
    price: price.toString(),
    acceptedSpeed: acceptedTh.toString(),
    ...(market ? { market } : {}),
  };
}

describe('evaluateProviders', () => {
  it('computes both effective prices = fill-line/fillable + overpay, in sat/PH/day', () => {
    // Braiins fillable 45,000,000 sat/EH/day = 45,000 sat/PH/day. +100 overpay = 45,100.
    // NiceHash fill line: cheapest filling order 4.836e-7 BTC/TH/day = 48,360 sat/PH/day. +100 = 48,460.
    const r = evaluateProviders({
      braiinsFillableSatPerEhDay: 45_000_000,
      nicehashOrders: [order(4.912e-7, 1000), order(4.836e-7, 8)],
      nicehashMarketFactor: MF,
      overpaySatPerPhDay: 100,
      switchConfig: SWITCH,
      prevProviderState: ON_BRAIINS,
      now: T0,
    });
    expect(r.braiinsEffectiveSatPerPhDay).toBeCloseTo(45_100, 3);
    expect(r.nicehashFillLineSatPerPhDay).toBeCloseTo(48_360, 2);
    expect(r.nicehashEffectiveSatPerPhDay).toBeCloseTo(48_460, 2);
    // Braiins is cheaper here -> stays active.
    expect(r.selection.preferredByPrice).toBe('BRAIINS');
  });

  it('prefers NiceHash when its effective price is >3.25% below Braiins', () => {
    // Braiins fillable 50,000,000 sat/EH/day = 50,000 sat/PH/day; +100 = 50,100.
    // NiceHash fill line 4.8e-7 = 48,000; +100 = 48,100. Advantage ~4.0%.
    const r = evaluateProviders({
      braiinsFillableSatPerEhDay: 50_000_000,
      nicehashOrders: [order(4.8e-7, 5000)],
      nicehashMarketFactor: MF,
      overpaySatPerPhDay: 100,
      switchConfig: { switchThresholdPct: 3.25, sustainedWindowMinutes: 0 }, // immediate
      prevProviderState: ON_BRAIINS,
      now: T0,
    });
    expect(r.selection.preferredByPrice).toBe('NICEHASH');
    expect(r.selection.switched).toBe(true);
    expect(r.selection.activeProvider).toBe('NICEHASH');
  });

  it('filters NiceHash orders to the configured market', () => {
    const r = evaluateProviders({
      braiinsFillableSatPerEhDay: 50_000_000,
      nicehashOrders: [
        order(4.0e-7, 5000, 'USA'), // cheaper, wrong market - must be ignored
        order(4.8e-7, 5000, 'EU'),
      ],
      nicehashMarketFactor: MF,
      nicehashMarket: 'EU',
      overpaySatPerPhDay: 100,
      switchConfig: SWITCH,
      prevProviderState: ON_BRAIINS,
      now: T0,
    });
    // Only the EU order counts -> fill line 48,000, not 40,000.
    expect(r.nicehashFillLineSatPerPhDay).toBeCloseTo(48_000, 2);
  });

  it('nulls the NiceHash side and holds Braiins when the order book is missing', () => {
    const r = evaluateProviders({
      braiinsFillableSatPerEhDay: 50_000_000,
      nicehashOrders: null,
      nicehashMarketFactor: null,
      overpaySatPerPhDay: 100,
      switchConfig: SWITCH,
      prevProviderState: ON_BRAIINS,
      now: T0,
    });
    expect(r.nicehashEffectiveSatPerPhDay).toBeNull();
    expect(r.selection.preferredByPrice).toBeNull();
    expect(r.selection.activeProvider).toBe('BRAIINS');
  });

  it('applies per-provider fees to the switch comparison, not the submitted bid', () => {
    // Raw: Braiins 50,100 vs NiceHash 49,100 -> only ~2% cheaper, under 3.25% -> Braiins stays.
    // Add a 3% Braiins fee (post-beta): Braiins cost 51,603 vs NiceHash 49,100 -> ~4.8% -> NiceHash wins.
    const r = evaluateProviders({
      braiinsFillableSatPerEhDay: 50_000_000, // 50,000; +100 overpay = 50,100
      nicehashOrders: [order(4.9e-7, 5000)], // 49,000; +100 = 49,100
      nicehashMarketFactor: MF,
      overpaySatPerPhDay: 100,
      braiinsFeePct: 3,
      nicehashFeePct: 0,
      switchConfig: { switchThresholdPct: 3.25, sustainedWindowMinutes: 0 },
      prevProviderState: ON_BRAIINS,
      now: T0,
    });
    // Submitted bids are unchanged (fee-exclusive)...
    expect(r.braiinsEffectiveSatPerPhDay).toBeCloseTo(50_100, 3);
    expect(r.nicehashEffectiveSatPerPhDay).toBeCloseTo(49_100, 2);
    // ...but the fee-adjusted cost flips the decision to NiceHash.
    expect(r.braiinsCostSatPerPhDay).toBeCloseTo(51_603, 0);
    expect(r.selection.preferredByPrice).toBe('NICEHASH');
    expect(r.selection.switched).toBe(true);
  });

  it('with zero fees, cost equals effective (behaviour unchanged)', () => {
    const r = evaluateProviders({
      braiinsFillableSatPerEhDay: 50_000_000,
      nicehashOrders: [order(4.9e-7, 5000)],
      nicehashMarketFactor: MF,
      overpaySatPerPhDay: 100,
      switchConfig: SWITCH,
      prevProviderState: ON_BRAIINS,
      now: T0,
    });
    expect(r.braiinsCostSatPerPhDay).toBe(r.braiinsEffectiveSatPerPhDay);
    expect(r.nicehashCostSatPerPhDay).toBe(r.nicehashEffectiveSatPerPhDay);
  });

  it('nulls the Braiins side when fillable is unavailable', () => {
    const r = evaluateProviders({
      braiinsFillableSatPerEhDay: null,
      nicehashOrders: [order(4.8e-7, 5000)],
      nicehashMarketFactor: MF,
      overpaySatPerPhDay: 100,
      switchConfig: SWITCH,
      prevProviderState: ON_BRAIINS,
      now: T0,
    });
    expect(r.braiinsEffectiveSatPerPhDay).toBeNull();
    expect(r.nicehashEffectiveSatPerPhDay).toBeCloseTo(48_100, 2);
    // Can't compare with a missing price -> hold active.
    expect(r.selection.preferredByPrice).toBeNull();
  });
});
