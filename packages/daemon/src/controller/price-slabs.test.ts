import { describe, expect, it } from 'vitest';

import { DEFAULT_PRICE_SLABS, decideSlabTarget, parseSlabs } from './price-slabs.js';

const HP = 50_000; // hashprice, sat/PH/day
const base = { feePct: 0, hashpriceSatPerPhDay: HP, slabs: DEFAULT_PRICE_SLABS, fallbackTargetPh: 2 };

describe('decideSlabTarget (B6 operator table)', () => {
  it('below break-even buys the biggest slab', () => {
    const r = decideSlabTarget({ ...base, effectivePriceSatPerPhDay: 49_000 }); // 98%
    expect(r.targetPh).toBe(3);
    expect(r.park).toBe(false);
  });

  it.each([
    [50_200, 2.5], // 100.4%
    [50_700, 2], //   101.4%
    [51_200, 1.5], // 102.4%
    [51_700, 1], //   103.4%
  ])('price %i maps to %s PH', (price, expected) => {
    expect(decideSlabTarget({ ...base, effectivePriceSatPerPhDay: price }).targetPh).toBe(expected);
  });

  it('above the top slab parks (uneconomic)', () => {
    const r = decideSlabTarget({ ...base, effectivePriceSatPerPhDay: 52_500 }); // 105%
    expect(r.targetPh).toBe(0);
    expect(r.park).toBe(true);
  });

  it('FEES push a nominally-cheap price into a smaller slab', () => {
    // 49,900 raw = 99.8% -> would be the 3 PH slab. With NiceHash's 3% fee the
    // real cost is 51,397 = 102.8% -> 1.5 PH. This is exactly the case the
    // operator flagged: the ceiling/sizing must be fee-inclusive.
    const withoutFee = decideSlabTarget({ ...base, effectivePriceSatPerPhDay: 49_900 });
    const withFee = decideSlabTarget({ ...base, feePct: 3, effectivePriceSatPerPhDay: 49_900 });
    expect(withoutFee.targetPh).toBe(3);
    expect(withFee.targetPh).toBe(1.5);
  });

  it('boundaries are exclusive on the upper edge', () => {
    // exactly 100% is NOT < 100, so it falls into the 100-101 slab.
    expect(decideSlabTarget({ ...base, effectivePriceSatPerPhDay: HP }).targetPh).toBe(2.5);
  });

  it('falls back to the configured target when hashprice is unknown', () => {
    const r = decideSlabTarget({
      ...base,
      hashpriceSatPerPhDay: null,
      effectivePriceSatPerPhDay: 49_000,
    });
    expect(r.targetPh).toBe(2);
    expect(r.park).toBe(false);
  });
});

describe('parseSlabs', () => {
  it('returns defaults for empty / invalid input', () => {
    expect(parseSlabs(null)).toEqual(DEFAULT_PRICE_SLABS);
    expect(parseSlabs('')).toEqual(DEFAULT_PRICE_SLABS);
    expect(parseSlabs('not json')).toEqual(DEFAULT_PRICE_SLABS);
    expect(parseSlabs('[]')).toEqual(DEFAULT_PRICE_SLABS);
  });

  it('parses and sorts a custom table', () => {
    const s = parseSlabs('[{"maxPct":102,"targetPh":1},{"maxPct":100,"targetPh":4}]');
    expect(s).toEqual([
      { maxPct: 100, targetPh: 4 },
      { maxPct: 102, targetPh: 1 },
    ]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const s = parseSlabs('[{"maxPct":100,"targetPh":4},{"maxPct":"x"},{"targetPh":-1}]');
    expect(s).toEqual([{ maxPct: 100, targetPh: 4 }]);
  });
});
