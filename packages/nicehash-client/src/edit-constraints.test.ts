import { describe, expect, it } from 'vitest';

import {
  evaluateNicehashPriceEdit,
  parseNicehashDecreaseCooldownSeconds,
} from './edit-constraints.js';

const T0 = 1_000_000_000_000;
const MIN = 60_000;

describe('evaluateNicehashPriceEdit - increases', () => {
  it('allows any increase in one edit (unrestricted; needed for reactivation)', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 48_600, // +600, straight to target
      lastDecreaseAtMs: T0, // just decreased - does NOT block an increase
      now: T0 + 1000, // inside the decrease cooldown - irrelevant for increases
      constraints: {},
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('INCREASE');
    expect(r.submitPriceSatPerPhDay).toBe(48_600);
  });
});

describe('evaluateNicehashPriceEdit - decreases', () => {
  it('blocks a decrease inside the 10-minute cooldown', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_000,
      lastDecreaseAtMs: T0,
      now: T0 + 5 * MIN, // 5 min < 10 min
      constraints: {},
    });
    expect(r.allowed).toBe(false);
    expect(r.denialReason).toBe('DECREASE_COOLDOWN');
  });

  it('clamps a large decrease to ONE cap-sized step (never a multiple)', () => {
    // Want to come down 600; NiceHash caps a single edit at 200, so we submit
    // exactly current-200 and finish the rest on later ticks. This is the
    // regression: the old code snapped to 600 in one go and NiceHash 5063'd it.
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_400, // -600 = 3 steps' worth
      lastDecreaseAtMs: T0,
      now: T0 + 10 * MIN,
      constraints: {},
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('DECREASE');
    expect(r.submitPriceSatPerPhDay).toBe(47_800); // 48,000 - 200 (one step only)
    expect(r.clampedByCap).toBe(true);
  });

  it('goes straight to target when it is within one step', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_850, // -150 <= 200 cap
      lastDecreaseAtMs: null,
      now: T0,
      constraints: {},
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('DECREASE');
    expect(r.submitPriceSatPerPhDay).toBe(47_850); // exact target, no overshoot
    expect(r.clampedByCap).toBe(false);
  });

  it('allows an exact one-step decrease', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_800, // exactly -200
      lastDecreaseAtMs: null,
      now: T0,
      constraints: {},
    });
    expect(r.allowed).toBe(true);
    expect(r.submitPriceSatPerPhDay).toBe(47_800);
    expect(r.clampedByCap).toBe(false);
  });

  it('never overshoots below the desired price', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_950, // -50 only
      lastDecreaseAtMs: null,
      now: T0,
      constraints: {},
    });
    expect(r.submitPriceSatPerPhDay!).toBeGreaterThanOrEqual(47_950);
  });

  it('honors a custom cap and cooldown', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_000, // -1000
      lastDecreaseAtMs: null,
      now: T0,
      constraints: { maxPriceDecreaseStepSatPerPhDay: 500, priceDecreaseCooldownMs: 5 * MIN },
    });
    expect(r.allowed).toBe(true);
    expect(r.submitPriceSatPerPhDay).toBe(47_500); // one 500 step
    expect(r.clampedByCap).toBe(true);
  });

  it('still honors the deprecated min* field name as the cap', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_000,
      lastDecreaseAtMs: null,
      now: T0,
      constraints: { minPriceDecreaseStepSatPerPhDay: 300 },
    });
    expect(r.submitPriceSatPerPhDay).toBe(47_700); // one 300 step
  });
});

describe('parseNicehashDecreaseCooldownSeconds', () => {
  it('extracts the exact seconds from a live cooldown rejection body', () => {
    const body = {
      error_id: 'abc',
      errors: [
        {
          code: 5062,
          message:
            'Order price decreased not allowed within 10 minutes of last price change. Seconds till available: 544',
        },
      ],
    };
    expect(parseNicehashDecreaseCooldownSeconds(body)).toBe(544);
  });

  it('returns null for an unrelated error body (e.g. 5063 too-big)', () => {
    const body = { errors: [{ code: 5063, message: 'Order price change is too big' }] };
    expect(parseNicehashDecreaseCooldownSeconds(body)).toBeNull();
  });

  it('returns null for malformed / non-cooldown bodies', () => {
    expect(parseNicehashDecreaseCooldownSeconds(null)).toBeNull();
    expect(parseNicehashDecreaseCooldownSeconds({})).toBeNull();
    expect(parseNicehashDecreaseCooldownSeconds('nope')).toBeNull();
  });
});

describe('evaluateNicehashPriceEdit - no change', () => {
  it('reports NONE when the price is unchanged', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 48_000,
      lastDecreaseAtMs: null,
      now: T0,
    });
    expect(r.allowed).toBe(false);
    expect(r.kind).toBe('NONE');
    expect(r.denialReason).toBe('NO_CHANGE');
  });
});
