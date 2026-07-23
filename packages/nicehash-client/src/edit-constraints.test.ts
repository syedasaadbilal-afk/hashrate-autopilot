import { describe, expect, it } from 'vitest';

import { evaluateNicehashPriceEdit } from './edit-constraints.js';

const T0 = 1_000_000_000_000;
const MIN = 60_000;

describe('evaluateNicehashPriceEdit - increases', () => {
  it('allows any increase regardless of cooldown or step', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 48_050, // +50, below the 200 step
      lastDecreaseAtMs: T0, // just decreased - would block a decrease
      now: T0 + 1000, // inside cooldown
      constraints: {},
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('INCREASE');
    expect(r.submitPriceSatPerPhDay).toBe(48_050);
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

  it('allows a decrease once the cooldown has elapsed', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_600, // -400 = 2 whole steps
      lastDecreaseAtMs: T0,
      now: T0 + 10 * MIN,
      constraints: {},
    });
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe('DECREASE');
    expect(r.submitPriceSatPerPhDay).toBe(47_600);
  });

  it('snaps a decrease down to whole 200-sat steps, never below target', () => {
    // Want to come down 500; only 2 whole steps (400) are allowed -> land at 47,600 (>= 47,500).
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_500,
      lastDecreaseAtMs: null,
      now: T0,
      constraints: {},
    });
    expect(r.allowed).toBe(true);
    expect(r.submitPriceSatPerPhDay).toBe(47_600); // 48,000 - 2*200
    expect(r.submitPriceSatPerPhDay!).toBeGreaterThanOrEqual(47_500);
  });

  it('blocks a decrease smaller than one step', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_850, // -150 < 200
      lastDecreaseAtMs: null,
      now: T0,
      constraints: {},
    });
    expect(r.allowed).toBe(false);
    expect(r.denialReason).toBe('DECREASE_BELOW_MIN_STEP');
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
  });

  it('honors custom step and cooldown', () => {
    const r = evaluateNicehashPriceEdit({
      currentPriceSatPerPhDay: 48_000,
      desiredPriceSatPerPhDay: 47_500,
      lastDecreaseAtMs: null,
      now: T0,
      constraints: { minPriceDecreaseStepSatPerPhDay: 500, priceDecreaseCooldownMs: 5 * MIN },
    });
    expect(r.allowed).toBe(true);
    expect(r.submitPriceSatPerPhDay).toBe(47_500); // exactly one 500 step
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
