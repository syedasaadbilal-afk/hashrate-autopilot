import { describe, expect, it } from 'vitest';

import {
  phToSpeedUnits,
  priceToSatPerEhDay,
  priceToSatPerPhDay,
  roundToNicehashPriceTick,
  satPerPhDayToPrice,
  speedUnitsToPh,
} from './units.js';

// SHA256's marketFactor corresponds to TH/s (1e12 H/s per unit).
const SHA256_MARKET_FACTOR = 1e12;
// The live SHA256 EH market: marketFactor 1e18, price quoted in BTC/EH/day.
const SHA256_EH_MARKET_FACTOR = 1e18;

describe('roundToNicehashPriceTick', () => {
  it('rounds a 5-decimal price to 4 decimals (NiceHash 2997 fix)', () => {
    // 48,199 sat/PH/day -> 0.48199 BTC/EH/day (5 dp, rejected) -> 0.4820.
    const price = satPerPhDayToPrice(48_199, SHA256_EH_MARKET_FACTOR);
    expect(roundToNicehashPriceTick(price)).toBeCloseTo(0.482, 12);
  });

  it('leaves an already-4-decimal price unchanged', () => {
    // 48,010 sat/PH/day -> exactly 0.4801 BTC/EH/day.
    const price = satPerPhDayToPrice(48_010, SHA256_EH_MARKET_FACTOR);
    expect(roundToNicehashPriceTick(price)).toBeCloseTo(0.4801, 12);
  });

  it('never emits more than 4 decimal places', () => {
    for (const sat of [47_989, 48_111, 48_199, 50_001, 48_007]) {
      const rounded = roundToNicehashPriceTick(
        satPerPhDayToPrice(sat, SHA256_EH_MARKET_FACTOR),
      );
      // 4-decimal grid: value * 1e4 must be an integer.
      expect(Math.abs(rounded * 1e4 - Math.round(rounded * 1e4))).toBeLessThan(1e-6);
    }
  });
});

describe('priceToSatPerPhDay', () => {
  it('converts 1e-8 BTC/TH/day to 1,000 sat/PH/day', () => {
    // 1e-8 BTC/TH/day * 1000 TH/PH * 1e8 sat/BTC = 1000 sat/PH/day
    expect(priceToSatPerPhDay(0.00000001, SHA256_MARKET_FACTOR)).toBeCloseTo(1000, 6);
  });

  it('round-trips through satPerPhDayToPrice', () => {
    const price = 0.00000123;
    const sat = priceToSatPerPhDay(price, SHA256_MARKET_FACTOR);
    const back = satPerPhDayToPrice(sat, SHA256_MARKET_FACTOR);
    expect(back).toBeCloseTo(price, 12);
  });
});

describe('priceToSatPerEhDay', () => {
  it('is 1000x priceToSatPerPhDay (EH = 1000 PH)', () => {
    const price = 0.00000005;
    const ph = priceToSatPerPhDay(price, SHA256_MARKET_FACTOR);
    const eh = priceToSatPerEhDay(price, SHA256_MARKET_FACTOR);
    expect(eh).toBeCloseTo(ph * 1000, 4);
  });
});

describe('speed unit conversions', () => {
  it('converts PH to speed units and back', () => {
    const ph = 2.5;
    const units = phToSpeedUnits(ph, SHA256_MARKET_FACTOR);
    // 2.5 PH = 2500 TH, and SHA256's unit is TH.
    expect(units).toBeCloseTo(2500, 6);
    expect(speedUnitsToPh(units, SHA256_MARKET_FACTOR)).toBeCloseTo(ph, 10);
  });
});
