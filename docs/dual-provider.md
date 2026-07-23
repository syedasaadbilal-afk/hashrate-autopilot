# Dual-provider (Braiins + NiceHash) — design, wiring, and s9pk build

Status as of this doc: the **decision engine is built and unit-tested**; the
**daemon/dashboard wiring and s9pk rebuild** are the remaining steps and are
specified exactly below. The design is **DRY-RUN-first**: when wired, the
daemon boots observing *both* marketplaces and logging which one it *would*
rent from, risking nothing, until you flip it LIVE from the dashboard.

The whole feature is gated behind a single `nicehash_enabled` config flag
(default **false**). With it off, the daemon behaves exactly as the current
Braiins-only build — so shipping this never disturbs the running autopilot
until you deliberately turn it on.

---

## 1. What the autopilot does with two providers

Rent from **exactly one** marketplace at a time, routed to the same
OCEAN/DATUM pool. Each tick:

1. Read both order books.
2. Compute the **effective bid** we'd post on each — the cheapest price that
   fills, plus the overpay cushion:
   - **Braiins**: `fillable_ask` (depth-aware, existing) + overpay.
   - **NiceHash**: `lowestFillingPrice` (the operator-confirmed rule — the
     cheapest order currently receiving hashrate) + overpay.
3. **Pick the provider**: NiceHash only if its effective price is **strictly
   more than 3.25 % cheaper** than Braiins, and only after it holds that edge
   continuously for the **sustained window** (default matches your cheap-mode
   window). Switching back to Braiins is symmetric. This prevents flapping —
   every switch is a cancel-here / recreate-there cycle with real downtime.
4. **Act** on the winner (LIVE only): keep/track a bid on the active provider,
   cancel any bid on the loser. In DRY-RUN, log the intended actions.

"Only one running at a time" means each switch has **bounded, observable
downtime** while the old order is cancelled and the new one is placed — the
same philosophy as the existing Braiins controller (bounded downtime, not
gapless uptime).

---

## 2. Modules already built and tested (committed)

| File | Purpose | Tests |
|---|---|---|
| `packages/nicehash-client/src/auth.ts` | HMAC-SHA256 v2 signing (org id + key + secret) | 4 |
| `packages/nicehash-client/src/client.ts` | Read + mutation client (order book, my orders, pools, create/edit/refill/cancel) | — |
| `packages/nicehash-client/src/units.ts` | marketFactor price/speed conversions | 4 |
| `packages/nicehash-client/src/orderbook.ts` | `lowestFillingPrice` (confirmed fill rule) + `cheapestFillableForDepth` + overpay | 11 |
| `packages/nicehash-client/src/edit-constraints.ts` | `evaluateNicehashPriceEdit` — 200-sat decrease steps + 10-min decrease cooldown; increases free | 8 |
| `packages/daemon/src/controller/provider-select.ts` | 3.25 % + sustained-window switch, symmetric, blip-safe | 12 |
| `packages/daemon/src/controller/evaluate-providers.ts` | ties fill-line + overpay + selection into one pure call | 5 |
| `scripts/smoke-nicehash.ts` | public-endpoint smoke test | — |
| `scripts/probe-nicehash-pricing-model.ts` | tiny real order → confirm pay-your-bid before LIVE | — |

Also changed: `overpay_sat_per_eh_day` default lowered `1_000_000 → 100_000`
(1,000 → 100 sat/PH/day) in `schema.ts`, for both providers. Live-editable.

Run the tests: `pnpm --filter @hashrate-autopilot/nicehash-client test` and
`npx vitest run packages/daemon/src/controller/provider-select.test.ts packages/daemon/src/controller/evaluate-providers.test.ts`.

The `evaluateProviders()` engine is the single call the tick makes. Everything
below is the plumbing that feeds it live data and acts on its output.

---

## 3. Wiring status

### 3.0 What is WIRED in this build (DRY-RUN, env-configured) — DONE

To reach a bootable DRY-RUN s9pk **without** risky, untestable config-table
migrations, this build wires the evaluation through **environment variables +
in-memory provider state**. It is committed and typechecks/builds clean; the
existing 158 controller/client tests pass. Each tick, when enabled, the daemon
polls the NiceHash order book, runs `evaluateProviders`, updates the in-memory
active provider, logs the decision, and exposes it at **`GET /api/provider`**.
It never touches the Braiins decide/execute path and places **no** orders.

Files: `services/nicehash-service.ts` (read service), `controller/tick.ts`
(guarded evaluation block + in-memory state + `getProviderEvaluation()`),
`main.ts` (env-driven construction), `http/routes/provider.ts` (+ registered
in `server.ts`).

**Enable it by setting these env vars** (in the StartOS wrapper's
`startos/main.ts` `env` block, or `docker run -e`):

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `NICEHASH_ENABLED` | yes | — | `true` turns the evaluation on |
| `NICEHASH_ORG_ID` / `NICEHASH_API_KEY` / `NICEHASH_API_SECRET` | yes | — | read-only-scoped NiceHash API creds (order book is a signed endpoint) |
| `NICEHASH_ALGORITHM` | no | `SHA256AsicBoost` | algo to track |
| `NICEHASH_MARKET` | no | all | your pool's region (e.g. `EU`, `USA`) |
| `PROVIDER_SWITCH_THRESHOLD_PCT` | no | `3.25` | how much cheaper NiceHash must be |
| `PROVIDER_SWITCH_SUSTAINED_WINDOW_MINUTES` | no | `10` | hold-time before a switch |
| `NICEHASH_MIN_DELIVERED_PH` | no | `0` | dust floor for the fill line |
| `BRAIINS_FEE_PCT` / `NICEHASH_FEE_PCT` | no | `0` | fees folded into the comparison |

With `NICEHASH_ENABLED` unset/false the daemon is byte-for-byte the current
Braiins-only build. `overpay` is read from your existing live config
(`overpay_sat_per_eh_day`). In-memory provider state resets to Braiins on
restart (conservative — a restart simply re-earns any switch); persisting it is
part of the config-table upgrade below.

Watch it after install: **service logs** show `[provider] …` each tick
(`SWITCH: …` on a change), and `curl http://<host>:3010/api/provider` returns
the live evaluation JSON.

### 3.1+ Upgrade path (LIVE + live-editable config + dashboard) — NOT in this build

The sections below describe moving the env config into the live-editable config
table (so you tune it from the dashboard), persisting provider state, adding
the dashboard card, and wiring the LIVE execution routing (park/refill/switch
from §4). These require the DB migrations + a runnable daemon to verify, so
they're the deliberate next step, not part of the DRY-RUN observe build.

### 3.1 Config fields — `packages/daemon/src/config/schema.ts`

Add to `AppConfigSchema` (near the pricing knobs):

```ts
// --- Dual-provider (NiceHash) ---
// Master switch. false = Braiins-only, identical to today's behaviour.
nicehash_enabled: z.boolean().default(false),
// NiceHash must be strictly MORE than this % cheaper than Braiins to win.
// Live-editable — pure switching margin, kept separate from fees below.
provider_switch_threshold_pct: z.number().nonnegative().default(3.25),
// Marketplace fees folded into the switch comparison (not the submitted bid).
// Braiins is fee-free during beta -> 0; set it when Braiins introduces a fee.
braiins_fee_pct: z.number().nonnegative().default(0),
nicehash_fee_pct: z.number().nonnegative().default(0),
// Challenger must hold its edge this many minutes before an actual switch.
provider_switch_sustained_window_minutes: nonNegativeInt.default(10),
// NiceHash market/region your pool order lives in (e.g. "EU", "USA"). Empty = all.
nicehash_market: z.string().default(''),
// NiceHash pool resource id pointing at your DATUM gateway (you created this).
nicehash_pool_id: z.string().default(''),
// NiceHash algorithm enum. SHA-256 with ASICBoost is "SHA256AsicBoost".
nicehash_algorithm: z.string().default('SHA256AsicBoost'),
// Dust floor (PH/s) for the NiceHash fill line; 0 = literal confirmed rule.
nicehash_min_delivered_ph: z.number().nonnegative().default(0),
```

And the same keys in the `APP_CONFIG_DEFAULTS` block with identical values.

### 3.2 Secrets — `packages/daemon/src/config/schema.ts`

Add to `SecretsSchema` (all optional so existing `.env.sops.yaml` still
parses; the order-book read is a *signed* endpoint, so these are required
before NiceHash evaluation produces prices):

```ts
nicehash_org_id: nonEmptyString.optional(),
nicehash_api_key: nonEmptyString.optional(),
nicehash_api_secret: nonEmptyString.optional(),
```

Add prompts for these to `scripts/setup.ts` (mirror the Braiins-token
prompts) and re-run `pnpm run setup` on the box, or add them to the sops file
with `pnpm run sops:edit`.

### 3.3 DB columns — `packages/daemon/src/state/types.ts`

- `ConfigTable`: add the seven config columns from 3.1 (booleans as `number`
  0/1 per this codebase's SQLite convention; the repo already coerces).
- `RuntimeStateTable`: `active_provider: string` (`'BRAIINS' | 'NICEHASH'`),
  `challenger_ready_since: number | null`.
- `TickMetricsTable`: `active_provider: string | null`,
  `braiins_effective_sat_per_ph_day: number | null`,
  `nicehash_effective_sat_per_ph_day: number | null`,
  `nicehash_advantage_pct: number | null`.

### 3.4 Migrations — new files under `packages/daemon/src/state/migrations/`

Follow the existing numbering (next is `0121_…`). All additive:

```sql
-- 0121_dual_provider_config.sql
ALTER TABLE config ADD COLUMN nicehash_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN provider_switch_threshold_pct REAL NOT NULL DEFAULT 3.25;
ALTER TABLE config ADD COLUMN provider_switch_sustained_window_minutes INTEGER NOT NULL DEFAULT 10;
ALTER TABLE config ADD COLUMN nicehash_market TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN nicehash_pool_id TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN nicehash_algorithm TEXT NOT NULL DEFAULT 'SHA256AsicBoost';
ALTER TABLE config ADD COLUMN nicehash_min_delivered_ph REAL NOT NULL DEFAULT 0;
```

```sql
-- 0122_dual_provider_runtime.sql
ALTER TABLE runtime_state ADD COLUMN active_provider TEXT NOT NULL DEFAULT 'BRAIINS';
ALTER TABLE runtime_state ADD COLUMN challenger_ready_since INTEGER;
```

```sql
-- 0123_dual_provider_tick_metrics.sql
ALTER TABLE tick_metrics ADD COLUMN active_provider TEXT;
ALTER TABLE tick_metrics ADD COLUMN braiins_effective_sat_per_ph_day REAL;
ALTER TABLE tick_metrics ADD COLUMN nicehash_effective_sat_per_ph_day REAL;
ALTER TABLE tick_metrics ADD COLUMN nicehash_advantage_pct REAL;
```

Register all three in `migrations/index.ts` in order. The migrations index
test verifies numbering/contiguity — run it: `npx vitest run packages/daemon/src/state/migrations`.

Update `RuntimeStateRepo` (`initializeIfMissing` defaults + `toDomain`) and
`ConfigRepo` to read/write the new columns, and add:

```ts
// RuntimeStateRepo
async setProviderState(active: 'BRAIINS' | 'NICEHASH', challengerReadySince: number | null) {
  await this.db.updateTable('runtime_state')
    .set({ active_provider: active, challenger_ready_since: challengerReadySince })
    .where('id', '=', 1).execute();
}
```

### 3.5 NiceHash service — `packages/daemon/src/services/nicehash-service.ts`

Mirror `braiins-service.ts`. Constructs a `NiceHashClient` from secrets,
caches `getAlgorithms()` (marketFactor rarely changes — refresh hourly), and
exposes `getOrderBook(algorithm)` and the algorithm lookup. Best-effort: every
method catches and returns null so a NiceHash outage never breaks the tick.
For LIVE (§4) it also wraps `createOrder` / `editOrderPriceAndLimit` /
`cancelOrder` / `getMyOrders`.

### 3.6 Daemon construction — `packages/daemon/src/main.ts`

When `config.nicehash_enabled` and the three secrets are present, build the
NiceHash client + service and pass them into the `Controller` deps. When not,
pass `undefined` — the tick block below no-ops.

### 3.7 Tick wiring — `packages/daemon/src/controller/tick.ts`

Add an **additive, guarded** block *after* the existing Braiins
`decide/gate/execute` (which stays untouched). In DRY-RUN this only observes
and logs:

```ts
// --- Dual-provider evaluation (additive; guarded) ---
if (this.deps.nicehashService && state.config.nicehash_enabled) {
  try {
    const algo = await this.deps.nicehashService.getAlgorithm(state.config.nicehash_algorithm);
    const orders = await this.deps.nicehashService.getOrderBook(state.config.nicehash_algorithm);
    const rt = await this.deps.runtimeRepo.get();
    const evald = evaluateProviders({
      braiinsFillableSatPerEhDay: state.fillable_ask_sat_per_eh_day,
      nicehashOrders: orders,
      nicehashMarketFactor: algo?.marketFactor ?? null,
      nicehashMarket: state.config.nicehash_market || undefined,
      nicehashMinDeliveredPh: state.config.nicehash_min_delivered_ph,
      overpaySatPerPhDay: state.config.overpay_sat_per_eh_day / 1000,
      switchConfig: {
        switchThresholdPct: state.config.provider_switch_threshold_pct,
        sustainedWindowMinutes: state.config.provider_switch_sustained_window_minutes,
      },
      prevProviderState: {
        activeProvider: (rt?.active_provider as 'BRAIINS' | 'NICEHASH') ?? 'BRAIINS',
        challengerReadySince: rt?.challenger_ready_since ?? null,
      },
      now: state.tick_at,
    });
    await this.deps.runtimeRepo.setProviderState(
      evald.selection.activeProvider,
      evald.selection.challengerReadySince,
    );
    // persist evald.* onto the tick_metrics row (add the four fields to the insert)
    // and, in LIVE, route mutations per §4. In DRY-RUN, just log:
    if (evald.selection.switched) {
      console.info(`[provider] ${evald.selection.reason}`);
      // optional: this.deps.systemEventsRepo.insert(...) for the timeline
    }
  } catch (err) {
    console.warn(`[provider] evaluation failed (non-fatal): ${(err as Error).message}`);
  }
}
```

Extend the `tick_metrics` insert with the four new columns from
`evald.braiinsEffectiveSatPerPhDay`, `evald.nicehashEffectiveSatPerPhDay`,
`evald.selection.activeProvider`, `evald.selection.nicehashAdvantagePct`.

### 3.8 Status API — `packages/daemon/src/http/routes/status.ts`

Add `active_provider`, `braiins_effective_sat_per_ph_day`,
`nicehash_effective_sat_per_ph_day`, `nicehash_advantage_pct`, and the switch
`reason` to the status payload, read from the latest tick / runtime state.

### 3.9 Dashboard tile (needs a dashboard build)

A small "Active provider" card on the Status page: which provider is live,
both effective prices, NiceHash's % advantage, and the switch countdown when a
challenger is arming. Add a Config → Strategy section for the NiceHash fields.
This is the one piece that can't be validated headless — it needs
`pnpm --filter @hashrate-autopilot/dashboard build`.

---

## 4. Going LIVE (after the probe — see §5)

DRY-RUN needs none of this; it's the execution routing for when you flip LIVE.

- **Braiins decide** (`decide.ts`): add one guarded block near the top — when
  `active_provider !== 'BRAIINS'`, **park** the owned Braiins bid: EDIT_PRICE
  its price down to `computeParkPrice(braiinsFillLine, park_margin)`, below the
  fillable ask. Braiins is pay-your-bid, so a bid below fill delivers zero and
  costs zero while staying alive — the same design as NiceHash, so the handover
  is symmetric and neither side churns a recreate. Do **not** cancel on a
  switch. (The existing Datum-stratum-down *cancel-all* safety path is separate
  and unchanged — that's "pool is unreachable, stop everything", not a provider
  switch.) The parking decrease still flows through the existing `gate.ts`
  cooldown (read from Braiins' `min_bid_price_decrease_period_s`); Braiins has
  no min-step. Reactivation is the normal fillable-tracking path raising the
  bid back up — an increase, uncapped.
- **NiceHash decide** (`decide-nicehash.ts` — built + tested, 10 tests). When
  `active_provider === 'NICEHASH'`, returns the ordered actions for a single
  long-lived order: CREATE (only when none exists), REFILL, EDIT_PRICE, CANCEL.
  Needs a `nicehash_orders` ledger table mirroring `owned_bids` (store
  `remaining_btc` and `last_price_decrease_at`). Feed it
  `nicehash_effective` (fill line + overpay) and the order snapshot; route the
  returned actions to the NiceHash service in `execute.ts`.
- **NiceHash refill economy** (operator-confirmed 2026-07-22, encoded in
  `decideNicehash`). A NEW NiceHash order costs ~1,000 sats; **refilling** an
  existing one is free. So the NiceHash controller keeps ONE order alive and
  **REFILLs** its budget when it drops below the runway threshold, rather than
  letting it expire and recreating (which is how the *Braiins* controller
  operates — new orders there are free). A price move is always an in-place
  EDIT_PRICE, never a cancel+recreate. A new order is created only on first
  entry or after a switch-away CANCEL — which is another reason the provider
  switch is gated by the sustained window: each re-entry re-pays the
  new-order fee, so we must not churn it on noise. New config knobs:
  `nicehash_refill_threshold_btc`, `nicehash_refill_amount_btc`,
  `nicehash_create_amount_btc`.
- **NiceHash price-edit mechanics** (operator-confirmed 2026-07-22, encoded in
  `nicehash-client/src/edit-constraints.ts`, `evaluateNicehashPriceEdit`,
  7 tests). NiceHash is asymmetric:
  - **Decreases**: only in whole steps of **200 sat/PH/day**, and at most once
    per **10 minutes**. The function snaps a wanted decrease down to whole
    steps that never land *below* the target (so we satisfy the step rule
    without overshooting past the fill line), and blocks decreases that are
    inside the cooldown or smaller than one step.
  - **Increases**: unrestricted — any amount, any time. When the fill line
    rises, raise immediately (no cooldown, no step).
  Wire this into the NiceHash gate: run `evaluateNicehashPriceEdit` on every
  proposed EDIT and submit `submitPriceSatPerPhDay` (or skip when
  `!allowed`). The step/cooldown are config-overridable
  (`minPriceDecreaseStepSatPerPhDay`, `priceDecreaseCooldownMs`).
- **Braiins price-edit mechanics** (unchanged): decrease cooldown only,
  read dynamically from Braiins' `min_bid_price_decrease_period_s` market
  setting (so if it's 5 min now, the daemon already uses 5 min), and **no**
  minimum-step constraint. Handled by the existing `gate.ts` — no change.
- **execute** (`execute.ts`): route NiceHash proposals to the NiceHash service.
  The DRY-RUN/LIVE/PAUSED gate is unchanged and covers both providers.
- **NiceHash has no pause — park instead of cancel** (operator-confirmed
  2026-07-22, encoded in `decideNicehash`). To idle a NiceHash order when
  Braiins wins, **drop its price below the fill line** (a decrease) so it stops
  matching and sits at zero cost while staying alive. Reactivate by **raising
  the price back above the fill line** — an unrestricted increase, so re-entry
  is instant and free. NiceHash is therefore **never cancelled on a routine
  switch** (that would re-pay the ~1,000-sat new-order fee); CANCEL is reserved
  for a hard teardown (operator disables NiceHash). The caller passes a
  `parkPriceSatPerPhDay` = fill line minus the shared safety margin
  (`park_margin_sat_per_ph_day`), floored at NiceHash's minimum.
  Note: the parking decrease obeys the 10-min decrease cooldown, so a park can
  be delayed up to 10 min — the order keeps filling at its old price until then
  (bounded; the switch is already sustained-window gated).
- **Handover (uniform)**: on a switch, the loser is **parked** (both providers,
  via `computeParkPrice` / `park.ts`) and the winner is raised back to
  fill + overpay. Nothing is cancelled. Two orders actively *filling* must
  never overlap — but a parked order (below fill, zero delivery) sitting idle on
  the other venue is fine and expected. CANCEL is reserved for a hard teardown
  (provider disabled) via the NiceHash `teardown` flag / the Braiins
  Datum-down safety path.

---

## 5. Pre-LIVE checklist

1. **Run the probe** (spends a few thousand sats, cancels itself):
   ```
   NICEHASH_ORG_ID=… NICEHASH_API_KEY=… NICEHASH_API_SECRET=… \
   NICEHASH_POOL_ID=<your pool id> NICEHASH_MARKET=<region> \
     pnpm tsx scripts/probe-nicehash-pricing-model.ts --confirm
   ```
   Confirm the verdict is **pay-your-bid**. If it's pay-at-ask, revisit the
   overpay tuning before LIVE (the fill-line logic still holds).
2. Soak in **DRY-RUN** for a few days; watch the switch log and confirm
   NiceHash's advantage is durable and the sustained window behaves.
3. Fund the NiceHash account; verify `nicehash_pool_id` points at DATUM.
4. Flip to LIVE from the dashboard, small `bid_budget`, watch one full switch
   cycle end-to-end before trusting it unattended.

---

## 6. Build and upload the new s9pk

Your s9pk wraps a container image pulled from `ghcr.io`
(`startos/manifest/index.ts` → `dockerTag`). New daemon code means a **new
image**, then a **repackage**. Two steps:

### 6.1 Publish a new image from this monorepo

0. **Gate first (run the tests yourself).** The Docker build runs `pnpm build`
   (typecheck + compile + dashboard bundle), **not** `pnpm test`. So on your dev
   machine: `pnpm install && pnpm test` — must be all green — and optionally
   `pnpm daemon` to confirm it boots and `:3010` serves. This is the real gate
   on the wiring; I can't run it here.
1. Bump the version: `BUILD_NUMBER` and `rdouma-hashrate-autopilot/umbrel-app.yml`
   `version:` (the workflow reads the image's app-version from there) — e.g. `1.18.0`.
2. Push to your GitHub fork and push a `v1.18.0` tag. The repo's
   `.github/workflows/docker-publish.yml` builds `packages/daemon` +
   `packages/dashboard` for amd64+arm64 and publishes
   `ghcr.io/<your-gh-user>/hashrate-autopilot:1.18.0`. Make that GHCR package
   **public** (Package settings → visibility) so the s9pk build can pull it.
   (Locally instead: `docker build -t ghcr.io/<you>/hashrate-autopilot:1.18.0 . && docker push …`.)

### 6.2 Repackage and sideload (your existing startos wrapper)

In your `hashrate-autopilot-startos` wrapper repo (from `files.zip` /
`BUILD-AND-SIDELOAD.md`):

1. `startos/manifest/index.ts` → set `dockerTag: 'ghcr.io/<you>/hashrate-autopilot:1.18.0'`.
2. `startos/versions/current.ts` → bump `version: '1.18.0:0'`, add a release
   note. Leave `migrations.up` empty — this build adds no SQLite migrations.
3. **Enable dual-provider via the env block** in `startos/main.ts`. In the
   daemon's `exec.env`, alongside `NODE_ENV`/`HTTP_PORT`/`DB_PATH`, add:
   ```ts
   NICEHASH_ENABLED: 'true',
   NICEHASH_ORG_ID: '<your org id>',
   NICEHASH_API_KEY: '<read-only-scoped key>',
   NICEHASH_API_SECRET: '<secret>',
   NICEHASH_MARKET: 'EU',            // your pool's region
   NICEHASH_ALGORITHM: 'SHA256AsicBoost',
   // optional: PROVIDER_SWITCH_THRESHOLD_PCT, ...SUSTAINED_WINDOW_MINUTES, BRAIINS_FEE_PCT, NICEHASH_FEE_PCT
   ```
   Use a **read-only-scoped** NiceHash key — this build only reads the order
   book, and a read-only key can't place orders or move funds even if the
   wrapper repo leaks. (Leave `NICEHASH_ENABLED` out entirely to ship a
   pure Braiins-only build.)
4. Commit, push, GitHub → Actions → **Build** → Run workflow (~10 min).
5. Download the **x86_64** s9pk artifact.
6. StartOS UI → System → **Sideload Service** → the .s9pk → install.

Service state (config, secrets, history DB) **persists across the reinstall**,
so your Braiins history and settings carry over. It boots in **DRY-RUN** and,
with the env above, evaluates both marketplaces each tick without placing any
order. Watch it two ways: the **service logs** (`[provider] …` lines) and
`curl http://<box>:3010/api/provider`. Nothing is ever bid on NiceHash in this
build — LIVE execution is the next step (§4 + §3.1+).

---

## 7. Config quick reference

| Knob | Default | Meaning |
|---|---|---|
| `nicehash_enabled` | false | master switch; off = Braiins-only |
| `overpay_sat_per_eh_day` | 100,000 (=100 sat/PH/day) | cushion above the fill line, both providers |
| `provider_switch_threshold_pct` | 3.25 | NiceHash must be strictly cheaper by more than this (live-editable; pure switching margin) |
| `braiins_fee_pct` | 0 | Braiins fee folded into the switch comparison; set when Braiins ends its no-fee beta |
| `nicehash_fee_pct` | 0 | NiceHash marketplace fee folded into the switch comparison |
| `provider_switch_sustained_window_minutes` | 10 | challenger must hold its edge this long before switching |
| `nicehash_market` | "" | your pool's NiceHash region (e.g. EU/USA); empty = all |
| `nicehash_pool_id` | "" | NiceHash pool resource pointing at DATUM |
| `nicehash_algorithm` | SHA256AsicBoost | the algo you rent |
| `nicehash_min_delivered_ph` | 0 | dust floor for the fill line; 0 = literal confirmed rule |
| `park_margin_sat_per_ph_day` | 5,000 | how far below the fill line a parked (idle) order/bid sits, both providers |
| `nicehash_refill_threshold_btc` | — | refill the NiceHash order when remaining budget drops below this |
| `nicehash_refill_amount_btc` | — | how much to top up on each refill |
| `nicehash_create_amount_btc` | — | initial budget when first creating the NiceHash order |
