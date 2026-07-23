/**
 * Smoke test: call the public NiceHash algorithms endpoint, and (if
 * credentials are present in the environment) the signed order book
 * endpoint too. Proves the auth signing + typed client chain works
 * end-to-end. Places no orders.
 *
 * Usage:
 *   pnpm tsx scripts/smoke-nicehash.ts
 *
 * With credentials (optional, enables the order-book call):
 *   NICEHASH_ORG_ID=... NICEHASH_API_KEY=... NICEHASH_API_SECRET=... \
 *     pnpm tsx scripts/smoke-nicehash.ts
 */

import { createNiceHashClient } from '@hashrate-autopilot/nicehash-client';

async function main() {
  const client = createNiceHashClient({
    orgId: process.env['NICEHASH_ORG_ID'],
    apiKey: process.env['NICEHASH_API_KEY'],
    apiSecret: process.env['NICEHASH_API_SECRET'],
    baseUrl: process.env['NICEHASH_BASE_URL'],
  });

  console.log('→ GET /main/api/v2/mining/algorithms/ (public)');
  const algos = await client.getAlgorithms();
  const sha256 = algos.miningAlgorithms.find((a) => a.algorithm === 'SHA256');
  console.log(`algorithms: ${algos.miningAlgorithms.length}`);
  if (sha256) {
    console.log(
      `SHA256: marketFactor=${sha256.marketFactor} speedText=${sha256.speedText} displayMarketFactor=${sha256.displayMarketFactor}`,
    );
  } else {
    console.log('SHA256 not found in algorithms response - printing raw:');
    console.log(JSON.stringify(algos, null, 2).slice(0, 2000));
  }

  const hasCreds =
    process.env['NICEHASH_ORG_ID'] && process.env['NICEHASH_API_KEY'] && process.env['NICEHASH_API_SECRET'];
  if (!hasCreds) {
    console.log(
      '\n(skipping order-book call - set NICEHASH_ORG_ID / NICEHASH_API_KEY / NICEHASH_API_SECRET to test signed requests)',
    );
    return;
  }

  console.log('\n→ GET /main/api/v2/hashpower/orderBook/?algorithm=SHA256 (signed)');
  const book = await client.getOrderBook('SHA256');
  console.log(`orders: ${book.orders.length}`);
  const top = [...book.orders].sort((a, b) => Number(b.price) - Number(a.price))[0];
  if (top) console.log(`top order: ${JSON.stringify(top)}`);
}

main().catch((err) => {
  console.error('\nSmoke test failed:');
  console.error(err);
  process.exit(1);
});
