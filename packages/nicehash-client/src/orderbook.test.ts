import { describe, expect, it } from 'vitest';

import type { NiceHashOrderBookOrder, NiceHashOrderBookResponse } from './client.js';
import {
  cheapestFillableForDepth,
  desiredBidAboveFillable,
  extractMarketBook,
  lowestFillingPrice,
} from './orderbook.js';

// SHA256 marketFactor corresponds to TH/s. API `price` is therefore
// BTC per TH per day, and speeds are in TH units. priceToSatPerPhDay
// multiplies BTC/TH/day by 1e11 (see units.ts), so 4.9e-7 -> 49,000
// sat/PH/day, matching the marketplace UI's "BTC/EH/day" column / 1000.
const MF = 1e12;

// Helper: build an order. `price` in BTC/TH/day, `acceptedTh` in TH units
// (1000 TH delivered = 1 PH/s of grabbable supply).
function order(price: number, acceptedTh: number): NiceHashOrderBookOrder {
  return { id: `o-${price}-${acceptedTh}`, price: price.toString(), acceptedSpeed: acceptedTh.toString() };
}

describe('cheapestFillableForDepth', () => {
  it('returns the cheapest price whose cumulative delivered supply (from the bottom up) covers the target', () => {
    const orders = [
      order(4.0e-7, 500), // 40,000 sat/PH/day, 0.5 PH delivered
      order(4.5e-7, 1000), // 45,000 sat/PH/day, 1.0 PH -> cum 1.5 PH
      order(4.9e-7, 800), // 49,000 sat/PH/day, 0.8 PH -> cum 2.3 PH covers 2 PH
      order(5.0e-7, 0), // priced high but receiving nothing - ignored
    ];
    const r = cheapestFillableForDepth(orders, 2, MF);
    expect(r.thin).toBe(false);
    expect(r.priceSatPerPhDay).toBeCloseTo(49_000, 3);
    expect(r.priceSatPerEhDay).toBeCloseTo(49_000_000, 0);
    expect(r.cumulativePh).toBeCloseTo(2.3, 6);
  });

  it('ignores orders that are not receiving hashrate (acceptedSpeed 0)', () => {
    const orders = [
      order(3.0e-7, 0), // below the fill line
      order(4.5e-7, 1500), // 45,000 sat/PH/day, 1.5 PH covers 1 PH
    ];
    const r = cheapestFillableForDepth(orders, 1, MF);
    expect(r.priceSatPerPhDay).toBeCloseTo(45_000, 3);
    expect(r.thin).toBe(false);
  });

  it('falls back to the highest delivering price when the whole book cannot cover the target (thin)', () => {
    const orders = [order(4.0e-7, 500), order(4.5e-7, 1000), order(4.9e-7, 800)];
    const r = cheapestFillableForDepth(orders, 5, MF); // total 2.3 PH < 5 PH
    expect(r.thin).toBe(true);
    expect(r.priceSatPerPhDay).toBeCloseTo(49_000, 3); // top delivering order
    expect(r.cumulativePh).toBeCloseTo(2.3, 6);
  });

  it('returns null for an empty book', () => {
    expect(cheapestFillableForDepth([], 1, MF).priceSatPerPhDay).toBeNull();
    expect(cheapestFillableForDepth(undefined, 1, MF).priceSatPerPhDay).toBeNull();
  });

  it('returns null when no order is receiving any hashrate', () => {
    const orders = [order(4.0e-7, 0), order(4.5e-7, 0)];
    const r = cheapestFillableForDepth(orders, 1, MF);
    expect(r.priceSatPerPhDay).toBeNull();
    expect(r.thin).toBe(true);
  });
});

describe('extractMarketBook (live API shape: stats.<market>.orders)', () => {
  // Mirrors the real response: orders nested under stats.BTC, marketFactor 1e18 (EH).
  const response: NiceHashOrderBookResponse = {
    stats: {
      BTC: {
        marketFactor: '1000000000000000000',
        displayMarketFactor: 'EH',
        priceFactor: '1000000000000000000',
        orders: [
          { id: 'a', type: 'BUSINESS', price: '0.52270000', acceptedSpeed: '0.00100000', alive: true, currencyMarket: 'BTC' },
          { id: 'b', type: 'STANDARD', price: '0.50280000', acceptedSpeed: '0.00200000', alive: true, currencyMarket: 'BTC' },
          { id: 'c', type: 'STANDARD', price: '0.49600000', acceptedSpeed: '0.00050000', alive: true, currencyMarket: 'BTC' }, // lowest filling
          { id: 'd', type: 'STANDARD', price: '0.49000000', acceptedSpeed: '0.00000000', alive: true, currencyMarket: 'BTC' }, // below fill line
          { id: 'e', type: 'STANDARD', price: '0.48000000', acceptedSpeed: '0', alive: true, currencyMarket: 'BTC' },
        ],
      },
    },
  };

  it('pulls the BTC market orders and its marketFactor (1e18)', () => {
    const book = extractMarketBook(response, 'BTC');
    expect(book).not.toBeNull();
    expect(book!.market).toBe('BTC');
    expect(book!.marketFactor).toBe(1e18);
    expect(book!.orders.length).toBe(5);
  });

  it('falls back to the first market when the configured one is absent (e.g. stale "EU")', () => {
    const book = extractMarketBook(response, 'EU');
    expect(book!.market).toBe('BTC'); // EU not present -> falls back
  });

  it('feeds lowestFillingPrice correctly: 0.4960 BTC/EH/day -> 49,600 sat/PH/day', () => {
    const book = extractMarketBook(response)!;
    const fill = lowestFillingPrice(book.orders, book.marketFactor);
    expect(fill.priceSatPerPhDay).toBeCloseTo(49_600, 0); // the cheapest order still receiving speed
  });

  it('returns null for an empty/missing stats object', () => {
    expect(extractMarketBook({ stats: {} })).toBeNull();
    expect(extractMarketBook(null)).toBeNull();
    expect(extractMarketBook({})).toBeNull();
  });
});

describe('lowestFillingPrice (confirmed rule)', () => {
  it('returns the cheapest price among orders currently receiving hashrate', () => {
    const orders = [
      order(4.9e-7, 1000), // filling
      order(4.5e-7, 800), // filling, cheaper
      order(4.0e-7, 0), // NOT filling (below the line) - ignored
    ];
    const r = lowestFillingPrice(orders, MF);
    expect(r.priceSatPerPhDay).toBeCloseTo(45_000, 3); // 4.5e-7, the cheapest filling order
    expect(r.thin).toBe(false);
  });

  it('reads the fill line from delivered speed, not price ordering (non-monotonic book)', () => {
    // Mirrors the confirming screenshot: an order at 0.4836 is filling while
    // higher-priced orders at 0.4838-0.4850 show zero speed. The fill line
    // is the *lowest price actually receiving hashrate* (0.4836-equivalent),
    // not the lowest price with a higher order above it.
    const orders = [
      order(4.912e-7, 1924), // filling
      order(4.856e-7, 20), // filling
      order(4.850e-7, 0), // higher price than 0.4836 but NOT filling
      order(4.840e-7, 0), // NOT filling
      order(4.838e-7, 0), // NOT filling
      order(4.836e-7, 8), // filling, and it's the cheapest one that is
      order(4.830e-7, 0), // NOT filling
    ];
    const r = lowestFillingPrice(orders, MF);
    expect(r.priceSatPerPhDay).toBeCloseTo(48_360, 2); // tracks 0.4836, the true fill line
  });

  it('minDeliveredPh filters a dust order out of the fill line', () => {
    // The 0.4836 order delivers only 0.008 PH (8 TH). With a dust floor above
    // that, the fill line jumps up to the next real filling order.
    const orders = [
      order(4.856e-7, 2000), // 2.0 PH delivered
      order(4.836e-7, 8), // 0.008 PH - dust
    ];
    const literal = lowestFillingPrice(orders, MF);
    expect(literal.priceSatPerPhDay).toBeCloseTo(48_360, 2); // dust sets the line

    const filtered = lowestFillingPrice(orders, MF, { minDeliveredPh: 0.01 });
    expect(filtered.priceSatPerPhDay).toBeCloseTo(48_560, 2); // dust ignored -> next order
  });

  it('returns null when nothing is filling, and adds overpay just above the line', () => {
    expect(lowestFillingPrice([order(4.0e-7, 0)], MF).priceSatPerPhDay).toBeNull();
    const line = lowestFillingPrice([order(4.836e-7, 8)], MF);
    const bid = desiredBidAboveFillable(line.priceSatPerPhDay!, 100, MF);
    expect(bid.priceSatPerPhDay).toBeCloseTo(48_460, 2); // fill line + 100 sat/PH/day
  });
});

describe('desiredBidAboveFillable', () => {
  it('adds the overpay cushion in sat/PH/day and round-trips to a BTC price', () => {
    const bid = desiredBidAboveFillable(49_000, 100, MF);
    expect(bid.priceSatPerPhDay).toBe(49_100);
    expect(bid.priceSatPerEhDay).toBe(49_100_000);
    // 49,100 sat/PH/day -> BTC/TH/day = 49_100 * 1e-11
    expect(bid.priceBtcPerUnitPerDay).toBeCloseTo(4.91e-7, 15);
  });

  it('default 100 sat/PH/day overpay sits just above the fill line, not the 1,000 the old Braiins default used', () => {
    const fillable = 45_000;
    expect(desiredBidAboveFillable(fillable, 100, MF).priceSatPerPhDay).toBe(45_100);
  });
});
