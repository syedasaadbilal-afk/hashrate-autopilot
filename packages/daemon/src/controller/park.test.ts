import { describe, expect, it } from 'vitest';

import { computeParkPrice, isParked } from './park.js';

describe('computeParkPrice', () => {
  it('parks a margin below the fill line', () => {
    expect(computeParkPrice({ fillLineSatPerPhDay: 48_000, marginSatPerPhDay: 5_000 })).toBe(43_000);
  });

  it('never goes below the provider floor', () => {
    expect(
      computeParkPrice({ fillLineSatPerPhDay: 3_000, marginSatPerPhDay: 5_000, floorSatPerPhDay: 500 }),
    ).toBe(500);
  });

  it('floors at 0 by default when margin exceeds the fill line', () => {
    expect(computeParkPrice({ fillLineSatPerPhDay: 3_000, marginSatPerPhDay: 5_000 })).toBe(0);
  });
});

describe('isParked', () => {
  it('is true at or below the park price', () => {
    expect(isParked(43_000, 43_000)).toBe(true);
    expect(isParked(20_000, 43_000)).toBe(true);
  });

  it('is false above the park price', () => {
    expect(isParked(48_000, 43_000)).toBe(false);
  });
});
