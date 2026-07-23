/**
 * Empirically determine how NiceHash's Hashpower marketplace prices
 * matched hashrate: pay-your-bid (actual spend = bid price × delivered) or
 * pay-at-ask / classic CLOB (actual spend ≤ bid price × delivered).
 *
 * This is the NiceHash equivalent of scripts/verify-pricing-model.ts,
 * which answered the same question for Braiins by mining historical
 * daemon data. NiceHash integration doesn't have that history yet, so
 * this script generates it directly: places a small REAL order, watches
 * it for a while, does a price edit partway through (mirroring the
 * 2026-04-23 Braiins A/B that discovered pay-your-bid there), and
 * compares NiceHash's own `payedAmount` counter against what pay-your-bid
 * would predict.
 *
 * Everything this script does is a real mutation against your NiceHash
 * account - it spends real BTC (bounded by --amount-btc) and places a
 * real order (bounded by --target-ph). It cancels the order in a
 * `finally` block so nothing is left running after the script exits or
 * errors, but the BTC already paid out during the observation window is
 * not refundable - that's the cost of getting a real answer instead of a
 * guess. Defaults are deliberately tiny.
 *
 * Required env vars: NICEHASH_ORG_ID, NICEHASH_API_KEY, NICEHASH_API_SECRET,
 * NICEHASH_POOL_ID, NICEHASH_MARKET (region code from your NiceHash pool
 * setup - check the order-creation form in the NiceHash UI or your
 * pool's configured region if unsure).
 *
 * Usage:
 *   NICEHASH_ORG_ID=... NICEHASH_API_KEY=... NICEHASH_API_SECRET=... \
 *   NICEHASH_POOL_ID=... NICEHASH_MARKET=EU \
 *     pnpm tsx scripts/probe-nicehash-pricing-model.ts --confirm
 *
 * Flags:
 *   --confirm                 required - without it, prints the plan and exits (no order placed)
 *   --amount-btc <n>          total order budget, BTC (default 0.00003 ≈ a few dollars)
 *   --target-ph <n>           speed_limit in PH/s (default 0.02 - small enough to be cheap to fill)
 *   --observe-minutes <n>     total observation window (default 12)
 *   --poll-seconds <n>        sample interval (default 60)
 *   --edit-at-minute <n>      when to do the price A/B edit (default: half of observe-minutes)
 *   --edit-delta-pct <n>      price change at the edit, percent (default -10, i.e. lower by 10%)
 */

import { createNiceHashClient, priceToSatPerPhDay, phToSpeedUnits } from '@hashrate-autopilot/nicehash-client';

const SAT_PER_BTC = 100_000_000;

interface Args {
  confirm: boolean;
  amountBtc: number;
  targetPh: number;
  observeMinutes: number;
  pollSeconds: number;
  editAtMinute: number;
  editDeltaPct: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: number): number => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || !argv[idx + 1]) return fallback;
    return Number(argv[idx + 1]);
  };
  const observeMinutes = get('--observe-minutes', 12);
  return {
    confirm: argv.includes('--confirm'),
    amountBtc: get('--amount-btc', 0.00003),
    targetPh: get('--target-ph', 0.02),
    observeMinutes,
    pollSeconds: get('--poll-seconds', 60),
    editAtMinute: get('--edit-at-minute', Math.round(observeMinutes / 2)),
    editDeltaPct: get('--edit-delta-pct', -10),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

interface Sample {
  atMs: number;
  price: number; // BTC per unit per day
  payedAmountBtc: number;
  acceptedSpeedUnits: number;
}

function fmtSat(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const orgId = requireEnv('NICEHASH_ORG_ID');
  const apiKey = requireEnv('NICEHASH_API_KEY');
  const apiSecret = requireEnv('NICEHASH_API_SECRET');
  const poolId = requireEnv('NICEHASH_POOL_ID');
  const market = requireEnv('NICEHASH_MARKET');
  const algorithm = process.env['NICEHASH_ALGORITHM'] ?? 'SHA256';

  const client = createNiceHashClient({ orgId, apiKey, apiSecret });

  console.log('=== NiceHash pricing-model probe ===');
  console.log(`market=${market} algorithm=${algorithm} poolId=${poolId}`);
  console.log(
    `amount=${args.amountBtc} BTC  target=${args.targetPh} PH/s  observe=${args.observeMinutes}m  ` +
      `poll=${args.pollSeconds}s  edit at minute ${args.editAtMinute} (${args.editDeltaPct}%)`,
  );

  const algosResp = await client.getAlgorithms();
  const algo = algosResp.miningAlgorithms.find((a) => a.algorithm === algorithm);
  if (!algo) throw new Error(`Algorithm ${algorithm} not found in NiceHash algorithms response`);
  console.log(`marketFactor=${algo.marketFactor} displayMarketFactor=${algo.displayMarketFactor}`);

  const book = await client.getOrderBook(algorithm);
  const topPrice = Math.max(0, ...book.orders.map((o) => Number(o.price)).filter(Number.isFinite));
  // Bid just above the current top order so the tiny test order actually
  // gets matched and delivers something to measure - a below-market price
  // would just sit unfilled and tell us nothing.
  const startPrice = topPrice > 0 ? topPrice * 1.02 : 0.00000005;
  console.log(
    `order book top price=${topPrice} BTC/unit/day → starting bid=${startPrice.toFixed(10)} ` +
      `(${fmtSat(priceToSatPerPhDay(startPrice, algo.marketFactor))} sat/PH/day)`,
  );

  if (!args.confirm) {
    console.log('\n(dry: pass --confirm to actually place this order. No mutation made.)');
    return;
  }

  const limitSpeedUnits = phToSpeedUnits(args.targetPh, algo.marketFactor);
  const created = await client.createOrder({
    market,
    algorithm,
    amountBtc: args.amountBtc,
    priceBtcPerUnitPerDay: startPrice,
    limitSpeedUnits,
    poolId,
    marketFactor: algo.marketFactor,
    displayMarketFactor: algo.displayMarketFactor,
  });
  const orderId = created.id;
  console.log(`\n→ order created: id=${orderId}`);

  const samples: Sample[] = [];
  let edited = false;

  try {
    const totalMs = args.observeMinutes * 60_000;
    const pollMs = args.pollSeconds * 1000;
    const editAtMs = args.editAtMinute * 60_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < totalMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const elapsedMs = Date.now() - startedAt;

      const mine = await client.getMyOrders(algorithm, market);
      const order = mine.list.find((o) => o.id === orderId);
      if (!order) {
        console.log(`  [${(elapsedMs / 60_000).toFixed(1)}m] order not found in myOrders yet`);
        continue;
      }
      const price = Number(order.price);
      const payedAmountBtc = Number(order.payedAmount ?? 0);
      const acceptedSpeedUnits = Number(order.acceptedSpeed ?? 0);
      samples.push({ atMs: Date.now(), price, payedAmountBtc, acceptedSpeedUnits });
      console.log(
        `  [${(elapsedMs / 60_000).toFixed(1)}m] price=${price} payedAmount=${payedAmountBtc} BTC ` +
          `acceptedSpeed=${acceptedSpeedUnits} status=${order.status?.code ?? '?'}`,
      );

      if (!edited && elapsedMs >= editAtMs) {
        const newPrice = price * (1 + args.editDeltaPct / 100);
        console.log(`  → editing price: ${price} → ${newPrice.toFixed(10)} (${args.editDeltaPct}%)`);
        await client.editOrderPriceAndLimit({
          orderId,
          priceBtcPerUnitPerDay: newPrice,
          limitSpeedUnits,
          marketFactor: algo.marketFactor,
          displayMarketFactor: algo.displayMarketFactor,
        });
        edited = true;
      }
    }
  } finally {
    console.log('\n→ cancelling order (always run, even on error)');
    try {
      await client.cancelOrder(orderId);
      console.log('  cancelled OK');
    } catch (err) {
      console.error(`  cancel FAILED - check the NiceHash UI to cancel ${orderId} manually:`, err);
    }
  }

  // ---- Verdict, same methodology as scripts/verify-pricing-model.ts ----
  if (samples.length < 2) {
    console.log('\nNot enough samples collected to score - try a longer --observe-minutes.');
    return;
  }

  let expectedSat = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    const durHours = (cur.atMs - prev.atMs) / 3_600_000;
    const deliveredPh = (prev.acceptedSpeedUnits * algo.marketFactor) / 1e15;
    const priceSatPhDay = priceToSatPerPhDay(prev.price, algo.marketFactor);
    expectedSat += (priceSatPhDay * deliveredPh * durHours) / 24;
  }

  const actualSat =
    (samples[samples.length - 1]!.payedAmountBtc - samples[0]!.payedAmountBtc) * SAT_PER_BTC;

  console.log('\n=== Result ===');
  console.log(`expected spend at bid price(s): ${fmtSat(expectedSat)} sat`);
  console.log(`actual payedAmount delta:       ${fmtSat(actualSat)} sat`);

  if (expectedSat <= 0) {
    console.log('\nNo expected spend computed (zero delivered hashrate) - order likely never filled.');
    console.log('Try a higher starting price or a longer window.');
    return;
  }

  const ratio = actualSat / expectedSat;
  console.log(`ratio (actual/expected): ${ratio.toFixed(4)}`);

  if (ratio >= 0.9 && ratio <= 1.1) {
    console.log('\nVERDICT: pay-your-bid (like Braiins). The bid price is the price paid.');
    console.log('decide.ts logic can reuse the same fillable-tracking formula for NiceHash.');
  } else if (ratio < 0.9) {
    const discountPct = (1 - ratio) * 100;
    console.log(`\nVERDICT: pay-at-ask / CLOB-like. Actual spend ~${discountPct.toFixed(1)}% below bid-price model.`);
    console.log('NiceHash pricing needs its own decide() formula, not a straight port of Braiins logic.');
  } else {
    console.log(`\nVERDICT: unexpected (ratio ${ratio.toFixed(4)} > 1.1). Check for fees, or re-run with a longer window.`);
  }
}

main().catch((err) => {
  console.error('\nProbe failed:');
  console.error(err);
  process.exit(1);
});
