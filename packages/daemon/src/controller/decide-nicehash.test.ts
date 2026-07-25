import { describe, expect, it } from 'vitest';

import { decideNicehash, type NicehashOrderSnapshot } from './decide-nicehash.js';

const T0 = 1_000_000_000_000;
const MIN = 60_000;

const NO_ORDER: NicehashOrderSnapshot = {
  exists: false,
  orderId: null,
  currentPriceSatPerPhDay: null,
  remainingBtc: null,
  lastDecreaseAtMs: null,
};

function liveOrder(over: Partial<NicehashOrderSnapshot> = {}): NicehashOrderSnapshot {
  return {
    exists: true,
    orderId: 'nh-1',
    currentPriceSatPerPhDay: 48_000,
    remainingBtc: 0.005,
    lastDecreaseAtMs: null,
    ...over,
  };
}

const BASE = {
  refillThresholdBtc: 0.001,
  refillAmountBtc: 0.002,
  createAmountBtc: 0.002,
  parkPriceSatPerPhDay: 20_000, // well below a ~48,000 fill line
  now: T0,
};

describe('decideNicehash - create only when none exists', () => {
  it('creates the sole order when NiceHash active and none exists', () => {
    const [a] = decideNicehash({
      ...BASE,
      providerActive: true,
      desiredPriceSatPerPhDay: 48_100,
      order: NO_ORDER,
    });
    expect(a!.kind).toBe('CREATE');
    expect(a!.submitPriceSatPerPhDay).toBe(48_100);
    expect(a!.amountBtc).toBe(0.002);
  });

  it('does not create when unpriceable', () => {
    const [a] = decideNicehash({
      ...BASE,
      providerActive: true,
      desiredPriceSatPerPhDay: null,
      order: NO_ORDER,
    });
    expect(a!.kind).toBe('NONE');
  });
});

describe('decideNicehash - refill keeps the order alive (no new-order fee)', () => {
  it('refills when remaining budget is below threshold', () => {
    const actions = decideNicehash({
      ...BASE,
      providerActive: true,
      desiredPriceSatPerPhDay: 48_000, // same price -> no edit
      order: liveOrder({ remainingBtc: 0.0005 }),
    });
    expect(actions.some((a) => a.kind === 'REFILL')).toBe(true);
    expect(actions.every((a) => a.kind !== 'CREATE' && a.kind !== 'CANCEL')).toBe(true);
    const refill = actions.find((a) => a.kind === 'REFILL')!;
    expect(refill.amountBtc).toBe(0.002);
    expect(refill.orderId).toBe('nh-1');
  });

  it('does not refill when budget is healthy', () => {
    const actions = decideNicehash({
      ...BASE,
      providerActive: true,
      desiredPriceSatPerPhDay: 48_000,
      order: liveOrder({ remainingBtc: 0.01 }),
    });
    expect(actions.some((a) => a.kind === 'REFILL')).toBe(false);
    expect(actions[0]!.kind).toBe('NONE');
  });
});

describe('decideNicehash - price tracking obeys NiceHash step/cooldown', () => {
  it('edits price in-place (never cancel+recreate) for an increase', () => {
    const actions = decideNicehash({
      ...BASE,
      providerActive: true,
      desiredPriceSatPerPhDay: 48_500, // +500 increase, unrestricted
      order: liveOrder({ remainingBtc: 0.01 }),
    });
    const edit = actions.find((a) => a.kind === 'EDIT_PRICE');
    expect(edit).toBeDefined();
    expect(edit!.submitPriceSatPerPhDay).toBe(48_500);
    expect(actions.every((a) => a.kind !== 'CANCEL' && a.kind !== 'CREATE')).toBe(true);
  });

  it('caps a large decrease at one 200-step per edit (NiceHash 5063 fix)', () => {
    const actions = decideNicehash({
      ...BASE,
      providerActive: true,
      desiredPriceSatPerPhDay: 47_500, // want -500; capped to one -200 step this edit
      order: liveOrder({ remainingBtc: 0.01, lastDecreaseAtMs: null }),
    });
    const edit = actions.find((a) => a.kind === 'EDIT_PRICE')!;
    expect(edit.submitPriceSatPerPhDay).toBe(47_800); // 48,000 - 200 (one step only)
  });

  it('holds price during the decrease cooldown but still refills if low', () => {
    const actions = decideNicehash({
      ...BASE,
      providerActive: true,
      now: T0 + 2 * MIN,
      desiredPriceSatPerPhDay: 47_000, // wants a decrease
      order: liveOrder({ remainingBtc: 0.0005, lastDecreaseAtMs: T0 }), // inside cooldown, low budget
    });
    expect(actions.some((a) => a.kind === 'EDIT_PRICE')).toBe(false); // cooldown blocks the decrease
    expect(actions.some((a) => a.kind === 'REFILL')).toBe(true); // refill still happens
  });

  it('refills AND edits price on the same tick when both are due', () => {
    const actions = decideNicehash({
      ...BASE,
      providerActive: true,
      desiredPriceSatPerPhDay: 48_400, // +400 increase
      order: liveOrder({ remainingBtc: 0.0005 }), // low budget
    });
    expect(actions.some((a) => a.kind === 'REFILL')).toBe(true);
    expect(actions.some((a) => a.kind === 'EDIT_PRICE')).toBe(true);
  });
});

describe('decideNicehash - switch-away parks (never cancels)', () => {
  it('parks by dropping price below the fill line, not cancelling', () => {
    const [a] = decideNicehash({
      ...BASE,
      providerActive: false,
      desiredPriceSatPerPhDay: 48_000,
      order: liveOrder({ currentPriceSatPerPhDay: 48_000, lastDecreaseAtMs: null }),
    });
    expect(a!.kind).toBe('PARK');
    expect(a!.orderId).toBe('nh-1');
    // Parking now walks down one 200-step per edit toward the park target
    // (a single 28,000-sat drop would bust NiceHash's per-edit cap / 5063).
    expect(a!.submitPriceSatPerPhDay).toBe(47_800); // 48,000 - 200 (one step)
  });

  it('does nothing when the order is already parked', () => {
    const [a] = decideNicehash({
      ...BASE,
      providerActive: false,
      desiredPriceSatPerPhDay: 48_000,
      order: liveOrder({ currentPriceSatPerPhDay: 20_000 }),
    });
    expect(a!.kind).toBe('NONE');
  });

  it('holds (does not park) while the decrease cooldown is active', () => {
    const [a] = decideNicehash({
      ...BASE,
      now: T0 + 2 * MIN,
      providerActive: false,
      desiredPriceSatPerPhDay: 48_000,
      order: liveOrder({ currentPriceSatPerPhDay: 48_000, lastDecreaseAtMs: T0 }),
    });
    expect(a!.kind).toBe('NONE'); // parking decrease blocked until cooldown clears
  });

  it('does nothing when inactive and no order exists', () => {
    const [a] = decideNicehash({
      ...BASE,
      providerActive: false,
      desiredPriceSatPerPhDay: null,
      order: NO_ORDER,
    });
    expect(a!.kind).toBe('NONE');
  });
});

describe('decideNicehash - reactivation raises a parked order (free, unrestricted)', () => {
  it('raises a parked order back to fill+overpay via an increase when NiceHash becomes active', () => {
    const actions = decideNicehash({
      ...BASE,
      providerActive: true,
      desiredPriceSatPerPhDay: 48_100,
      order: liveOrder({ currentPriceSatPerPhDay: 20_000, remainingBtc: 0.01, lastDecreaseAtMs: T0 - 60 * MIN }),
    });
    const edit = actions.find((a) => a.kind === 'EDIT_PRICE')!;
    expect(edit.submitPriceSatPerPhDay).toBe(48_100); // full increase, no step/cooldown
    expect(actions.every((a) => a.kind !== 'CREATE')).toBe(true); // reused, not recreated
  });
});

describe('decideNicehash - teardown is the only cancel path', () => {
  it('cancels only on explicit teardown', () => {
    const [a] = decideNicehash({
      ...BASE,
      providerActive: false,
      teardown: true,
      desiredPriceSatPerPhDay: null,
      order: liveOrder(),
    });
    expect(a!.kind).toBe('CANCEL');
    expect(a!.orderId).toBe('nh-1');
  });
});
