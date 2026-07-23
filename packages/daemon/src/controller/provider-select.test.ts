import { describe, expect, it } from 'vitest';

import {
  selectProvider,
  type ProviderSelectConfig,
  type ProviderSelectState,
} from './provider-select.js';

const CONFIG: ProviderSelectConfig = { switchThresholdPct: 3.25, sustainedWindowMinutes: 10 };
const T0 = 1_000_000_000_000;
const MIN = 60_000;

const onBraiins: ProviderSelectState = { activeProvider: 'BRAIINS', challengerReadySince: null };

describe('selectProvider - threshold', () => {
  it('keeps Braiins when NiceHash is cheaper but by 3.25% or less (in the no-switch band)', () => {
    // Braiins 50,000; NiceHash 48,500 -> 3.0% cheaper, under threshold.
    const r = selectProvider(
      { braiinsSatPerPhDay: 50_000, nicehashSatPerPhDay: 48_500 },
      CONFIG,
      onBraiins,
      T0,
    );
    expect(r.preferredByPrice).toBe('BRAIINS');
    expect(r.switched).toBe(false);
    expect(r.activeProvider).toBe('BRAIINS');
  });

  it('treats exactly 3.25% as NOT enough (strictly greater required)', () => {
    // 50,000 -> 48,375 is exactly 3.25% cheaper.
    const r = selectProvider(
      { braiinsSatPerPhDay: 50_000, nicehashSatPerPhDay: 48_375 },
      CONFIG,
      onBraiins,
      T0,
    );
    expect(r.preferredByPrice).toBe('BRAIINS');
  });

  it('prefers NiceHash once it is strictly more than 3.25% cheaper', () => {
    // 50,000 -> 48,000 is 4.0% cheaper.
    const r = selectProvider(
      { braiinsSatPerPhDay: 50_000, nicehashSatPerPhDay: 48_000 },
      CONFIG,
      onBraiins,
      T0,
    );
    expect(r.preferredByPrice).toBe('NICEHASH');
    expect(r.nicehashAdvantagePct).toBeCloseTo(4.0, 6);
  });
});

describe('selectProvider - sustained window', () => {
  const prices = { braiinsSatPerPhDay: 50_000, nicehashSatPerPhDay: 48_000 }; // 4% cheaper

  it('does not switch immediately; arms the challenger timer', () => {
    const r = selectProvider(prices, CONFIG, onBraiins, T0);
    expect(r.switched).toBe(false);
    expect(r.activeProvider).toBe('BRAIINS');
    expect(r.challengerReadySince).toBe(T0);
  });

  it('holds while inside the window', () => {
    const armed: ProviderSelectState = { activeProvider: 'BRAIINS', challengerReadySince: T0 };
    const r = selectProvider(prices, CONFIG, armed, T0 + 9 * MIN);
    expect(r.switched).toBe(false);
    expect(r.activeProvider).toBe('BRAIINS');
    expect(r.challengerReadySince).toBe(T0); // timer preserved
  });

  it('switches once the challenger has been preferred for the full window', () => {
    const armed: ProviderSelectState = { activeProvider: 'BRAIINS', challengerReadySince: T0 };
    const r = selectProvider(prices, CONFIG, armed, T0 + 10 * MIN);
    expect(r.switched).toBe(true);
    expect(r.activeProvider).toBe('NICEHASH');
    expect(r.challengerReadySince).toBeNull();
  });

  it('switches immediately when the window is 0', () => {
    const r = selectProvider(
      prices,
      { switchThresholdPct: 3.25, sustainedWindowMinutes: 0 },
      onBraiins,
      T0,
    );
    expect(r.switched).toBe(true);
    expect(r.activeProvider).toBe('NICEHASH');
  });

  it('resets the timer if the challenger loses preference mid-window', () => {
    const armed: ProviderSelectState = { activeProvider: 'BRAIINS', challengerReadySince: T0 };
    // NiceHash advantage drops to 2% (back in the band) before the window elapses.
    const r = selectProvider(
      { braiinsSatPerPhDay: 50_000, nicehashSatPerPhDay: 49_000 },
      CONFIG,
      armed,
      T0 + 5 * MIN,
    );
    expect(r.preferredByPrice).toBe('BRAIINS');
    expect(r.switched).toBe(false);
    expect(r.challengerReadySince).toBeNull(); // window reset - must re-accumulate from scratch
  });
});

describe('selectProvider - switch back to Braiins', () => {
  const onNicehash: ProviderSelectState = { activeProvider: 'NICEHASH', challengerReadySince: null };

  it('keeps NiceHash while it retains its >3.25% edge', () => {
    const r = selectProvider(
      { braiinsSatPerPhDay: 50_000, nicehashSatPerPhDay: 48_000 },
      CONFIG,
      onNicehash,
      T0,
    );
    expect(r.preferredByPrice).toBe('NICEHASH');
    expect(r.switched).toBe(false);
    expect(r.activeProvider).toBe('NICEHASH');
  });

  it('switches back to Braiins after NiceHash loses its edge for the full window', () => {
    // NiceHash edge falls to 1% (below threshold) -> Braiins price-preferred.
    const losing = { braiinsSatPerPhDay: 50_000, nicehashSatPerPhDay: 49_500 };
    const arm = selectProvider(losing, CONFIG, onNicehash, T0);
    expect(arm.preferredByPrice).toBe('BRAIINS');
    expect(arm.switched).toBe(false);
    expect(arm.challengerReadySince).toBe(T0);

    const armed: ProviderSelectState = {
      activeProvider: 'NICEHASH',
      challengerReadySince: T0,
    };
    const done = selectProvider(losing, CONFIG, armed, T0 + 10 * MIN);
    expect(done.switched).toBe(true);
    expect(done.activeProvider).toBe('BRAIINS');
  });
});

describe('selectProvider - missing data', () => {
  it('holds the active provider and resets the timer when a price is missing', () => {
    const armed: ProviderSelectState = { activeProvider: 'BRAIINS', challengerReadySince: T0 };
    const r = selectProvider(
      { braiinsSatPerPhDay: null, nicehashSatPerPhDay: 48_000 },
      CONFIG,
      armed,
      T0 + 5 * MIN,
    );
    expect(r.preferredByPrice).toBeNull();
    expect(r.switched).toBe(false);
    expect(r.activeProvider).toBe('BRAIINS');
    expect(r.challengerReadySince).toBeNull();
  });

  it('holds when both prices are missing', () => {
    const r = selectProvider(
      { braiinsSatPerPhDay: null, nicehashSatPerPhDay: null },
      CONFIG,
      { activeProvider: 'NICEHASH', challengerReadySince: null },
      T0,
    );
    expect(r.activeProvider).toBe('NICEHASH');
    expect(r.preferredByPrice).toBeNull();
  });
});
