/**
 * One control-loop tick: observe → decide → gate → execute + persist.
 *
 * Pure-ish orchestration layer; hosts no business logic itself.
 *
 * Controller state is minimal after the #49 redesign: only
 * `belowFloorSince` and `aboveFloorTicks` (both drive the below-floor
 * alerting in main.ts, nothing to do with fill strategy). The old
 * escalation/lowering-patience timers (`lowerReadySince`,
 * `belowTargetSince`) and the manual-override lock have been retired
 * along with the fill-strategy subsystem. Their runtime_state columns
 * are kept for backwards compatibility but always written as null.
 */


import { NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS } from '@hashrate-autopilot/nicehash-client';

import { decide } from './decide.js';
import { decideNicehash, type NicehashOrderAction } from './decide-nicehash.js';
import { evaluateProviders, type EvaluateProvidersResult } from './evaluate-providers.js';
import { execute, type ExecuteDeps } from './execute.js';
import { executeNicehash, type ExecuteNicehashResult } from './execute-nicehash.js';
import { gate } from './gate.js';
import { observe, type ObserveDeps } from './observe.js';
import { computeParkPrice } from './park.js';
import { decideSlabTarget, parseSlabs } from './price-slabs.js';
import { decidePauseEvent } from './pause-events.js';
import type { Provider, ProviderSelectState } from './provider-select.js';
import type { NiceHashLiveParams, NiceHashService } from '../services/nicehash-service.js';
import type { BidEventKind } from '../state/types.js';
import type { ExecutionResult, GateOutcome, Proposal, State } from './types.js';

export interface TickDeps extends ObserveDeps, ExecuteDeps {
  // `tickMetricsRepo` is inherited from ObserveDeps (#50).
  /** Sync read of the latest hashprice from Ocean stats (sat/PH/day). */
  readonly getHashprice?: () => number | null;
  /**
   * NiceHash read+trade service. Constructed in main.ts from the env-held API
   * credentials (org id / key / secret). When present AND config.nicehash_enabled
   * is true, the dual-provider evaluation + order maintenance run each tick.
   * All other tunables come from the live-editable config table.
   */
  readonly nicehashService?: NiceHashService;
}

/** The latest dual-provider evaluation, surfaced to the status API. */
export interface ProviderEvaluationSnapshot {
  readonly at: number;
  readonly activeProvider: Provider;
  readonly braiinsEffectiveSatPerPhDay: number | null;
  readonly nicehashEffectiveSatPerPhDay: number | null;
  /**
   * NiceHash fill line BEFORE overpay, sat/PH/day - the depth-aware cheapest
   * price whose real supply covers our target. Exposed so the dashboard can
   * show fill line / target / order price together and the operator can
   * reconcile against the NiceHash order book. null when unpriceable.
   */
  readonly nicehashFillLineSatPerPhDay: number | null;
  readonly braiinsCostSatPerPhDay: number | null;
  readonly nicehashCostSatPerPhDay: number | null;
  readonly nicehashAdvantagePct: number | null;
  readonly switched: boolean;
  readonly reason: string;
  /**
   * Human summary of what the NiceHash order maintenance will do this tick
   * (create / refill / lower price / park / hold), for the dashboard's Next
   * Action card when NiceHash is the active provider. null until the order
   * maintenance has run (pool id set) or when NiceHash is inactive.
   */
  readonly nicehashAction: string | null;
  /**
   * Live NiceHash order snapshot for the dashboard's NiceHash card, BIDS list,
   * and NiceHash-spend line in P&L. All null until the order maintenance runs
   * (pool id set) with a clean lookup, or when there's no order.
   */
  readonly nicehashOrder: {
    readonly exists: boolean;
    readonly orderId: string | null;
    readonly priceSatPerPhDay: number | null;
    readonly remainingBtc: number | null;
    readonly spentBtc: number | null;
    readonly acceptedSpeedPh: number | null;
    readonly limitPh: number | null;
    readonly status: string | null;
    /** B1: order expiry, epoch ms, best-effort - see NiceHashOrderSnapshot.expiresAtMs. */
    readonly expiresAtMs: number | null;
  } | null;
  /**
   * Exact seconds left on NiceHash's 10-min price-DECREASE cooldown, as
   * reported by NiceHash itself on a rejected decrease ("Seconds till
   * available: N"). Surfaced in the dashboard's Next Action card so the
   * operator sees precisely when the next lower can land. null when not on
   * cooldown / unknown.
   */
  readonly nicehashDecreaseCooldownSecondsLeft: number | null;
}

export interface TickResult {
  readonly state: State;
  readonly proposals: readonly Proposal[];
  readonly gated: readonly GateOutcome[];
  readonly executed: readonly ExecutionResult[];
}



/**
 * v1.18.16: safety margin added when arming NiceHash's 10-minute price-DECREASE
 * cooldown. We arm from `state.tick_at`, but NiceHash starts ITS timer when it
 * PROCESSES the change - a beat later - so our window expires marginally early
 * and the next attempt is rejected with 5061 "Seconds till available: 1".
 * Observed live 2026-07-31: 72 rejected calls (29 EDIT_PRICE + 43 PARK), every
 * one of them missing by a single second. Ticks are ~60 s apart, so waiting an
 * extra few seconds costs nothing - the decrease would land on the next tick
 * regardless - but it turns 72 wasted API calls into zero.
 */
const NICEHASH_COOLDOWN_SAFETY_MS = 15_000;

/**
 * v1.18.16: back-off after a REFILL is rejected. Live 2026-08-02/03 the NiceHash
 * wallet ran dry, the refill 409'd with 3001 "Insufficient balance in account",
 * and the daemon simply retried EVERY TICK - 140 such calls, after which
 * NiceHash began rejecting with 5102 "Order refill too frequent" (another 220).
 * 360 failed calls for one problem. A refill is never urgent to the second, so
 * on ANY refill rejection we stand down for this long before trying again.
 */
const NICEHASH_REFILL_BACKOFF_MS = 15 * 60_000;

export class Controller {
  private belowFloorSince: number | null = null;
  private aboveFloorTicks: number = 0;
  private lastResult: TickResult | null = null;

  /**
   * #287: previous tick's primary-bid pause observation, for
   * BID_PAUSED / BID_RESUMED transition detection. In-process only:
   * the first tick after a daemon restart establishes the baseline
   * without emitting an event (same blind spot as the
   * sustained_paused alert - a pause that happened entirely during
   * daemon downtime is not retroactively logged).
   */
  private prevPauseObservation: { orderId: string; paused: boolean } | null = null;

  /**
   * #dual-provider: in-memory provider-selection state. Held in memory (not
   * persisted) for this DRY-RUN cut - a daemon restart resets to BRAIINS with
   * a fresh sustained window, which is the conservative default (a restart
   * simply re-earns any switch). The latest evaluation is exposed to
   * /api/status via {@link getProviderEvaluation}.
   */
  private activeProvider: Provider = 'BRAIINS';
  private challengerReadySince: number | null = null;
  private lastProviderEvaluation: ProviderEvaluationSnapshot | null = null;

  /**
   * #56: Braiins-supplements-NiceHash state machine. NiceHash active + rationed
   * => Braiins runs concurrently (NiceHash throttled to 1 PH, Braiins un-parked).
   *   OFF       - normal single-active operation.
   *   ON        - supplement live: Braiins un-parked, NiceHash limit throttled.
   *   UNWINDING - market normalised: Braiins being parked this tick, NiceHash
   *               limit stays throttled one more tick so total never dips to 0;
   *               next tick returns to OFF and the NiceHash limit is restored.
   * Read one tick behind by decide() via state.nicehash_supplement_active, like
   * active_provider.
   */
  private nicehashSupplement: 'OFF' | 'ON' | 'UNWINDING' = 'OFF';

  /** B6: latest slab sizing decision (null when slab mode is disabled). */
  private slabDecision: ReturnType<typeof decideSlabTarget> | null = null;

  /** B6: expose the slab decision to the status API / dashboard. */
  getSlabDecision(): ReturnType<typeof decideSlabTarget> | null {
    return this.slabDecision;
  }

  /**
   * #dual-provider: epoch-ms until NiceHash's 10-min price-DECREASE cooldown
   * clears. Learned from (a) our own successful decreases and (b) the EXACT
   * "seconds till available" NiceHash returns on a rejected decrease - the
   * latter also captures a MANUAL operator edit that reset NiceHash's timer
   * without the daemon seeing it. Gates the daemon's own decreases so it stops
   * hammering the API, and feeds the remaining-seconds shown in Next Action.
   */
  private nicehashDecreaseCooldownUntilMs: number | null = null;

  /** v1.18.16: suppress REFILL until this epoch-ms after a rejected refill. */
  private nicehashRefillBackoffUntilMs: number | null = null;
  /** v1.18.16: last refill rejection reason, for the Next Action card. */
  private nicehashRefillBlockReason: string | null = null;

  /**
   * #dual-provider: last NiceHash order price we observed (sat/PH/day), so we
   * can DETECT a decrease between ticks - by anyone, including a MANUAL operator
   * edit - and start the cooldown clock from that observation. This is what
   * makes the Next Action cooldown appear even when the daemon itself never
   * attempted a decrease (NiceHash only reveals the exact seconds on a rejected
   * attempt). After our own decrease we baseline this to the submitted price so
   * the daemon's own edit isn't re-counted as a fresh drop next tick.
   */
  private nicehashLastPriceSatPerPhDay: number | null = null;

  /**
   * #dual-provider: false until the first provider evaluation after boot has
   * committed to a provider. On that first eval we pick whichever is
   * price-favorable RIGHT NOW and bypass the sustained window - a restart has no
   * incumbent to protect, so we should start on exactly ONE provider (the
   * favorable one) rather than defaulting in and slowly switching, which risks
   * briefly running both. After it's set, normal windowed switching resumes.
   */
  private providerBootSeeded = false;

  /**
   * #287 follow-up: the order id of a BID_PAUSED we have emitted and
   * not yet matched with a BID_RESUMED. A resume only emits when this
   * matches the current order - so a pause that began during downtime
   * (restart re-baselines as paused, no pause event) doesn't produce
   * an orphan resume that the dashboard can't place on a timeline.
   */
  private pauseEmittedOrderId: string | null = null;

  constructor(private readonly deps: TickDeps) {}

  /**
   * Seed in-memory floor-state from the persisted `runtime_state` row.
   * Call once at boot, after the migration runner. Idempotent.
   */
  async hydrate(): Promise<void> {
    const row = await this.deps.runtimeRepo.get();
    if (!row) return;
    this.belowFloorSince = row.below_floor_since_ms;
    this.aboveFloorTicks = row.above_floor_ticks;
    // #dual-provider: resume the persisted active provider so a restart while
    // NiceHash was active doesn't default to BRAIINS and place a throwaway
    // Braiins bid (which then can't be cancelled during its grace period).
    if (row.active_provider === 'NICEHASH' || row.active_provider === 'BRAIINS') {
      this.activeProvider = row.active_provider;
    }
  }

  async tick(): Promise<TickResult> {
    let state = await observe(this.deps, {
      previousBelowFloorSince: this.belowFloorSince,
      previousAboveFloorTicks: this.aboveFloorTicks,
      manualOverrideUntilMs: null,
      hashpriceSatPerPhDay: this.deps.getHashprice?.() ?? null,
      bypassPacing: false,
      // One tick behind (updated at the end of the previous tick's provider
      // evaluation) - bounds the handover lag to one tick.
      activeProvider: this.activeProvider,
      // #dual-provider: last-known NiceHash delivered speed (one tick behind),
      // so floor / zero-hashrate alerts reflect NiceHash when it's active.
      nicehashDeliveredPh: this.lastProviderEvaluation?.nicehashOrder?.acceptedSpeedPh ?? null,
      // #56: while supplementing (ON or unwinding), Braiins must stay live -
      // decide() reads this to skip parking. One tick behind, like the above.
      nicehashSupplementActive: this.nicehashSupplement !== 'OFF',
      // B6: slab sizing from the previous tick's evaluation (same one-tick lag
      // as activeProvider), so decide() sizes/parks Braiins consistently.
      slabTargetPh: this.slabDecision?.targetPh ?? null,
      slabPark: this.slabDecision?.park ?? false,
    });
    this.belowFloorSince = state.below_floor_since;
    this.aboveFloorTicks = state.above_floor_ticks;

    const proposals = decide(state);
    const gated = gate(proposals, state);
    const executed = await execute(this.deps, state, gated);

    // observe() ran *before* execute(), so `state.owned_bids` still
    // reflects the pre-execute world. Patch it in-memory so anything
    // downstream this tick (metrics row, lastResult consumed by
    // /api/status) sees the post-execute reality.
    const patchedOwnedBids = state.owned_bids
      .map((b) => {
        let next = b;
        const priceEdit = executed.find(
          (e) =>
            e.outcome === 'EXECUTED' &&
            e.proposal.kind === 'EDIT_PRICE' &&
            e.proposal.braiins_order_id === b.braiins_order_id,
        );
        if (priceEdit && priceEdit.proposal.kind === 'EDIT_PRICE') {
          next = { ...next, price_sat: priceEdit.proposal.new_price_sat };
        }
        const speedEdit = executed.find(
          (e) =>
            e.outcome === 'EXECUTED' &&
            e.proposal.kind === 'EDIT_SPEED' &&
            e.proposal.braiins_order_id === b.braiins_order_id,
        );
        if (speedEdit && speedEdit.proposal.kind === 'EDIT_SPEED') {
          next = { ...next, speed_limit_ph: speedEdit.proposal.new_speed_limit_ph };
        }
        return next;
      })
      .filter(
        (b) =>
          !executed.some(
            (e) =>
              e.outcome === 'EXECUTED' &&
              e.proposal.kind === 'CANCEL_BID' &&
              e.proposal.braiins_order_id === b.braiins_order_id,
          ),
      );
    state = { ...state, owned_bids: patchedOwnedBids };

    // #287: detect Braiins-side pause/resume on the primary bid and
    // log it to bid_events for the History page. The alert pipeline
    // (sustained_paused) keeps its 10-min threshold for paging; this
    // is the instant, unthresholded audit-trail row. Transition
    // detection requires seeing the SAME bid in both ticks - a fresh
    // bid that arrives already-paused doesn't fire (no transition we
    // observed), and a restart re-baselines silently.
    {
      const primary = state.owned_bids.find(
        (b) => b.status !== 'BID_STATUS_FULFILLED',
      );
      const cur =
        primary?.braiins_order_id != null
          ? {
              orderId: primary.braiins_order_id,
              paused: primary.status === 'BID_STATUS_PAUSED',
            }
          : null;
      const { emitKind, nextPauseEmittedOrderId } = decidePauseEvent(
        this.prevPauseObservation,
        cur,
        this.pauseEmittedOrderId,
      );
      this.pauseEmittedOrderId = nextPauseEmittedOrderId;
      if (emitKind !== null) {
        const pauseReason =
          emitKind === 'BID_PAUSED' && primary?.last_pause_reason
            ? `Braiins paused the bid: ${primary.last_pause_reason}`
            : emitKind === 'BID_PAUSED'
              ? 'Braiins paused the bid'
              : 'Braiins resumed the bid';
        await this.deps.bidEventsRepo
          .insert({
            occurred_at: state.tick_at,
            source: 'AUTOPILOT',
            kind: emitKind,
            braiins_order_id: cur!.orderId,
            old_price_sat: null,
            new_price_sat: null,
            speed_limit_ph: null,
            amount_sat: null,
            reason: pauseReason,
            overpay_sat_per_eh_day: null,
            max_overpay_vs_hashprice_sat_per_eh_day: null,
          })
          .catch(() => {
            // Pre-0111 CHECK constraint or transient write failure -
            // never let the audit row break the tick.
          });
      }
      this.prevPauseObservation = cur;
    }

    // Persist runtime diagnostics. The retired timers are nulled out
    // on every tick - their columns are kept only for backwards-compat
    // with the runtime_state table shape.
    await this.deps.runtimeRepo.patch({
      last_tick_at: state.tick_at,
      last_api_ok_at: state.last_api_ok_at,
      last_pool_ok_at: state.pool.last_ok_at,
      below_floor_since_ms: this.belowFloorSince,
      lower_ready_since_ms: null,
      below_target_since_ms: null,
      above_floor_ticks: this.aboveFloorTicks,
      // #dual-provider: persist the active provider so a restart resumes it.
      active_provider: this.activeProvider,
    });

    // Metrics snapshot - one row per tick, used by the Hashrate chart.
    try {
      const primary = [...state.owned_bids].sort((a, b) =>
        a.braiins_order_id.localeCompare(b.braiins_order_id),
      )[0];
      const primaryBalance = state.balance?.accounts?.[0];
      // Under pay-your-bid (#53) the authoritative actual spend comes
      // from `primary_bid_consumed_sat` deltas - keep the legacy
      // `spend_sat` column null so downstream readers don't confuse it
      // with the real figure.
      const spendSat: number | null = null;
      // #255: persist the EFFECTIVE target (post-cheap-mode) so the
      // chart's dashed "target" line steps when cheap-mode engages /
      // disengages. Previously this stored `config.target_hashrate_ph`
      // (the configured ceiling) regardless of cheap-mode state, so
      // the line was flat and the reporter had no way to see when the
      // controller had dropped to `cheap_target_hashrate_ph`.
      const effectiveTargetPh = state.cheap_mode_window?.engage
        ? state.config.cheap_target_hashrate_ph
        : state.config.target_hashrate_ph;
      await this.deps.tickMetricsRepo.insert({
        tick_at: state.tick_at,
        delivered_ph: state.actual_hashrate.braiins_ph,
        target_ph: effectiveTargetPh,
        floor_ph: state.config.minimum_floor_hashrate_ph,
        owned_bid_count: state.owned_bids.length,
        unknown_bid_count: state.unknown_bids.length,
        our_primary_price_sat_per_eh_day: primary?.price_sat ?? null,
        best_bid_sat_per_eh_day: state.market?.best_bid_sat ?? null,
        best_ask_sat_per_eh_day: state.market?.best_ask_sat ?? null,
        fillable_ask_sat_per_eh_day: state.fillable_ask_sat_per_eh_day,
        hashprice_sat_per_eh_day: state.hashprice_sat_per_ph_day !== null
          ? state.hashprice_sat_per_ph_day * 1000
          : null,
        max_bid_sat_per_eh_day: state.config.max_bid_sat_per_eh_day,
        // #312: historize the premium so the chart's effective-cap line
        // is accurate per tick (was applied as the current value across
        // all history, shifting the whole line when the knob changed).
        max_overpay_vs_hashprice_sat_per_eh_day:
          state.config.max_overpay_vs_hashprice_sat_per_eh_day,
        available_balance_sat: primaryBalance?.available_balance_sat ?? null,
        total_balance_sat: primaryBalance?.total_balance_sat ?? null,
        datum_hashrate_ph: state.datum?.hashrate_ph ?? null,
        ocean_hashrate_ph: state.ocean_hashrate_ph,
        share_log_pct: state.share_log_pct,
        spend_sat: spendSat,
        primary_bid_consumed_sat: primary ? primary.amount_consumed_sat : null,
        // #89: extended capture from sources we already poll.
        // observe() collects them onto State; tick.ts forwards.
        // primary_bid_fee_paid_sat is left null here - that field
        // lives on the per-bid detail counters, not the bids list,
        // and adding the per-bid /spot/bid/detail call is in scope
        // for #90 (bid acceptance ratio capture). Until then it
        // remains null.
        network_difficulty: state.network_difficulty,
        estimated_block_reward_sat: state.estimated_block_reward_sat,
        pool_hashrate_ph: state.pool_hashrate_ph,
        pool_active_workers: state.pool_active_workers,
        braiins_total_deposited_sat: state.braiins_total_deposited_sat,
        braiins_total_spent_sat: state.braiins_total_spent_sat,
        ocean_unpaid_sat: state.ocean_unpaid_sat,
        paid_total_sat: state.paid_total_sat,
        btc_usd_price: state.btc_usd_price,
        btc_usd_price_source: state.btc_usd_price_source,
        primary_bid_last_pause_reason: primary?.last_pause_reason ?? null,
        primary_bid_fee_paid_sat: null,
        primary_bid_fee_rate_pct: primary?.fee_rate_pct ?? null,
        pool_blocks_24h_count: state.pool_blocks_24h_count,
        pool_blocks_7d_count: state.pool_blocks_7d_count,
        pool_hashrate_ph_avg_24h: state.pool_hashrate_ph_avg_24h,
        pool_hashrate_ph_avg_7d: state.pool_hashrate_ph_avg_7d,
        pool_luck_24h: state.pool_luck_24h,
        pool_luck_7d: state.pool_luck_7d,
        pool_luck_30d: state.pool_luck_30d,
        // #243: snapshot the primary bid's cumulative share counters
        // here too. observe.ts made the /spot/bid/detail call once
        // per tick; tick.ts forwards the values verbatim.
        primary_bid_shares_purchased_m: state.primary_bid_shares_purchased_m,
        primary_bid_shares_accepted_m: state.primary_bid_shares_accepted_m,
        primary_bid_shares_rejected_m: state.primary_bid_shares_rejected_m,
        pool_blocks_30d_count: state.pool_blocks_30d_count,
        pool_hashrate_ph_avg_30d: state.pool_hashrate_ph_avg_30d,
        braiins_reachable: state.market !== null ? 1 : 0,
        // #224 (#222): per-tick snapshot of the operator's deadband
        // setting so the EDIT_PRICE tooltip can render the value that
        // was in effect at each historical edit.
        bid_edit_deadband_pct: state.config.bid_edit_deadband_pct,
        run_mode: state.run_mode,
        action_mode: 'NORMAL' as const,
        // #48/#49/#51: dual-provider attribution, one tick behind (the fresh
        // NiceHash order snapshot is fetched later this tick, in
        // evaluateProvidersTick). active_provider matches state.active_provider;
        // the NiceHash delivered/spend come from the last evaluation's order.
        active_provider: state.active_provider ?? 'BRAIINS',
        nicehash_delivered_ph:
          this.lastProviderEvaluation?.nicehashOrder?.acceptedSpeedPh ?? null,
        nicehash_consumed_sat:
          this.lastProviderEvaluation?.nicehashOrder?.spentBtc != null
            ? Math.round(this.lastProviderEvaluation.nicehashOrder.spentBtc * 1e8)
            : null,
      });
    } catch (err) {
      console.warn(`[tick] metrics insert failed: ${(err as Error).message}`);
    }

    // ---- Dual-provider evaluation (#dual-provider) --------------------------
    // Additive and fully isolated: never touches the Braiins decide/execute
    // path above. In DRY-RUN it only computes which provider WOULD be active
    // and logs it. Skipped entirely unless enabled + the NiceHash service is
    // wired, so a Braiins-only install is byte-for-byte unaffected.
    if (state.config.nicehash_enabled && this.deps.nicehashService) {
      try {
        await this.evaluateProvidersTick(state);
      } catch (err) {
        console.warn(`[provider] evaluation failed (non-fatal): ${(err as Error).message}`);
      }
    }

    const result: TickResult = { state, proposals, gated, executed };
    this.lastResult = result;
    return result;
  }

  private async evaluateProvidersTick(state: State): Promise<void> {
    // All tunables come from the live-editable config table (edit them on the
    // dashboard Config page - no rebuild). Only the API credentials live in env.
    const cfg = state.config;
    const svc = this.deps.nicehashService!;
    // One public request returns the whole book for the market, already
    // carrying its own authoritative marketFactor - no separate algorithm
    // lookup, and the market is selected here so no further filtering needed.
    const book = await svc.getMarketBook(cfg.nicehash_algorithm, cfg.nicehash_market || undefined);

    const prev: ProviderSelectState = {
      activeProvider: this.activeProvider,
      challengerReadySince: this.challengerReadySince,
    };
    const evald: EvaluateProvidersResult = evaluateProviders({
      braiinsFillableSatPerEhDay: state.fillable_ask_sat_per_eh_day,
      nicehashOrders: book?.orders ?? null,
      nicehashMarketFactor: book?.marketFactor ?? null,
      nicehashMinDeliveredPh: cfg.nicehash_min_delivered_ph,
      // Depth-aware fill line: anchor to where enough supply exists to fill our
      // whole target, not to a cheap order catching only a trickle.
      nicehashTargetPh: cfg.nicehash_target_hashrate_ph,
      // #55: rationing detector threshold - below this cumulative supply the
      // book is rationed, so stop chasing the price up and let Braiins supplement.
      nicehashDeepLiquidityEh: cfg.nicehash_deep_liquidity_eh,
      // #E: cumulative bottom-skip so the fill line ignores the thin cheap tail.
      nicehashFillSkipBottomEh: cfg.nicehash_fill_skip_bottom_eh,
      overpaySatPerPhDay: cfg.overpay_sat_per_eh_day / 1000,
      braiinsFeePct: cfg.braiins_fee_pct,
      nicehashFeePct: cfg.nicehash_fee_pct,
      // #60: compare on the ACTUAL deliverable price. Use the last-seen live
      // order price (one tick behind; the snapshot is fetched later this tick) so
      // Braiins isn't parked before NiceHash's capped/cooled-down price genuinely
      // converges, and a parked order can't look artificially cheap.
      nicehashCurrentOrderPriceSatPerPhDay: this.nicehashLastPriceSatPerPhDay,
      switchConfig: {
        switchThresholdPct: cfg.provider_switch_threshold_pct,
        sustainedWindowMinutes: cfg.provider_switch_sustained_window_minutes,
      },
      prevProviderState: prev,
      now: state.tick_at,
    });

    // #dual-provider: boot seed. On the FIRST evaluation after a restart, commit
    // straight to the price-favorable provider and bypass the sustained window -
    // a restart has no incumbent to protect, and this guarantees we start on
    // exactly ONE provider (never a Braiins bid while NiceHash is cheaper, or
    // vice-versa). Only seeds once a price-based preference exists this tick.
    let seededProvider = evald.selection.activeProvider;
    let seededChallengerReadySince = evald.selection.challengerReadySince;
    let bootSeedReason: string | null = null;
    if (!this.providerBootSeeded && evald.selection.preferredByPrice !== null) {
      seededProvider = evald.selection.preferredByPrice;
      seededChallengerReadySince = null;
      this.providerBootSeeded = true;
      if (seededProvider !== evald.selection.activeProvider) {
        bootSeedReason =
          `boot: start on ${seededProvider} (price-favorable now; sustained window ` +
          `bypassed on the first tick after restart)`;
        console.info(`[provider] ${bootSeedReason}`);
      }
    }

    this.activeProvider = seededProvider;
    this.challengerReadySince = seededChallengerReadySince;

    // #56: Braiins-supplements-NiceHash state machine. Advance it from this
    // tick's committed provider + rationing reading. It's read one tick behind
    // by decide() (via state.nicehash_supplement_active) and drives the NiceHash
    // throttle below, so the transition happens here (after the provider commit)
    // and the effects apply from the next observe.
    //   - NiceHash not active            -> OFF (single-active; Braiins primary).
    //   - NiceHash active + rationed      -> ON  (Braiins un-parked, NiceHash
    //                                             throttled to 1 PH; total ~2 PH).
    //   - NiceHash active + NOT rationed  -> unwind: ON->UNWINDING (park Braiins,
    //                                             keep NiceHash throttled a tick),
    //                                             UNWINDING->OFF (restore NiceHash
    //                                             to target). Never leaves NiceHash
    //                                             stuck at the throttled 1 PH.
    // #56/#A/#G (v1.18.14): the Braiins supplement is RETIRED - the daemon is
    // strictly SINGLE-ACTIVE again: rent from whichever venue is cheaper and park
    // the other.
    //
    // Why: the supplement existed to cover a NiceHash order that under-delivered
    // in a thin book. But the real cause was the fill-line anchoring on scraps,
    // which #E fixes properly (per-order dust floor + cumulative bottom skip, now
    // actually applied to the depth path). With a sound anchor there is nothing
    // left to compensate for.
    //
    // And the supplement was economically wrong: on 2026-07-27 it un-parked a full
    // 1 PH Braiins bid at 51,883 sat/PH/day while hashprice was ~50,700 and
    // NiceHash was already delivering 1.65 of the 2 PH target - buying unneeded
    // hashrate at a LOSS (#G). Rather than bolt on an economic gate plus shortfall
    // sizing, we drop the mode: a brief shortfall is cheaper than negative-margin
    // hash, and single-active is far easier to reason about.
    //
    // The flag remains in State/observe purely so decide() keeps compiling and any
    // in-flight parked bid unwinds cleanly; it is now permanently OFF.
    this.nicehashSupplement = 'OFF';

    // B6: slab sizing on the ACTIVE venue's fee-inclusive price as a % of
    // hashprice. Drives BOTH providers - and parks everything when the
    // market is above the top slab (previously nothing parked on "too
    // expensive", it just kept buying at the ceiling).
    const slabActiveIsNicehash = this.activeProvider === 'NICEHASH';
    const slabPrice = slabActiveIsNicehash
      ? evald.nicehashEffectiveSatPerPhDay
      : evald.braiinsEffectiveSatPerPhDay;
    const slabFeePct = slabActiveIsNicehash ? (cfg.nicehash_fee_pct ?? 0) : (cfg.braiins_fee_pct ?? 0);
    this.slabDecision = cfg.cheap_mode_slabs_enabled
      ? decideSlabTarget({
          effectivePriceSatPerPhDay: slabPrice,
          feePct: slabFeePct,
          hashpriceSatPerPhDay: state.hashprice_sat_per_ph_day,
          slabs: parseSlabs(cfg.cheap_mode_slabs),
          fallbackTargetPh: slabActiveIsNicehash
            ? cfg.nicehash_target_hashrate_ph
            : cfg.target_hashrate_ph,
        })
      : null;
    if (this.slabDecision) {
      console.info(`[slab] ${this.slabDecision.reason}`);
    }

    this.lastProviderEvaluation = {
      at: state.tick_at,
      activeProvider: seededProvider,
      braiinsEffectiveSatPerPhDay: evald.braiinsEffectiveSatPerPhDay,
      nicehashEffectiveSatPerPhDay: evald.nicehashEffectiveSatPerPhDay,
      nicehashFillLineSatPerPhDay: evald.nicehashFillLineSatPerPhDay,
      braiinsCostSatPerPhDay: evald.braiinsCostSatPerPhDay,
      nicehashCostSatPerPhDay: evald.nicehashCostSatPerPhDay,
      nicehashAdvantagePct: evald.selection.nicehashAdvantagePct,
      switched: evald.selection.switched,
      reason: bootSeedReason ?? evald.selection.reason,
      nicehashAction: null,
      nicehashOrder: null,
      nicehashDecreaseCooldownSecondsLeft: nicehashCooldownSecondsLeft(
        this.nicehashDecreaseCooldownUntilMs,
        state.tick_at,
      ),
    };

    if (evald.selection.switched) {
      console.info(`[provider] SWITCH: ${evald.selection.reason}`);
    } else {
      console.debug(`[provider] ${evald.selection.reason}`);
    }

    // ---- NiceHash order maintenance (LIVE-gated) --------------------------
    // Only when a pool id is configured (LIVE-capable) and the book priced.
    // decideNicehash produces the create/refill/edit/park/cancel actions;
    // executeNicehash runs them ONLY in run_mode LIVE - in DRY-RUN it logs the
    // parsed order snapshot + "would" actions so the reconcile can be verified
    // against a real order before any BTC moves.
    if (cfg.nicehash_pool_id && book && book.marketFactor > 0) {
      try {
        const snapshot = await svc.getMyOrder(cfg.nicehash_algorithm, book.market, book.marketFactor);
        console.info(
          `[nicehash] order snapshot: exists=${snapshot.exists} id=${snapshot.orderId ?? '-'} ` +
            `price=${snapshot.currentPriceSatPerPhDay === null ? '-' : Math.round(snapshot.currentPriceSatPerPhDay)} sat/PH/day ` +
            `remaining=${snapshot.remainingBtc === null ? '-' : snapshot.remainingBtc.toFixed(8)} BTC`,
        );
        // Surface the live order to the dashboard (card / BIDS / P&L spend) via
        // /api/provider. Only overwrite with a clean lookup so a transient blip
        // doesn't blank the card - a failed lookup keeps the last good order.
        if (snapshot.lookupOk && this.lastProviderEvaluation) {
          this.lastProviderEvaluation = {
            ...this.lastProviderEvaluation,
            nicehashOrder: {
              exists: snapshot.exists,
              orderId: snapshot.orderId,
              priceSatPerPhDay: snapshot.currentPriceSatPerPhDay,
              remainingBtc: snapshot.remainingBtc,
              spentBtc: snapshot.spentBtc,
              acceptedSpeedPh: snapshot.acceptedSpeedPh,
              limitPh: snapshot.limitPh,
              status: snapshot.statusCode,
              expiresAtMs: snapshot.expiresAtMs,
            },
          };
        }
        // Safety gate: if the order lookup didn't cleanly succeed, its result is
        // UNKNOWN - not a confirmed "no order". Hold this tick rather than risk a
        // CREATE that would duplicate an existing order on a transient API blip.
        // Order maintenance simply resumes on the next successful lookup.
        if (!snapshot.lookupOk) {
          console.warn('[nicehash] order lookup unavailable this tick - holding (no create/edit)');
          if (this.lastProviderEvaluation) {
            this.lastProviderEvaluation = {
              ...this.lastProviderEvaluation,
              nicehashAction: 'order status unavailable this tick - holding',
            };
          }
          return;
        }
        const parkPrice =
          evald.nicehashFillLineSatPerPhDay !== null
            ? computeParkPrice({
                fillLineSatPerPhDay: evald.nicehashFillLineSatPerPhDay,
                marginSatPerPhDay: cfg.park_margin_sat_per_ph_day,
              })
            : null;
        // #H (v1.18.14): apply the SAME price ceilings to NiceHash that the
        // Braiins path has always enforced - effective cap =
        // min(Maximum, hashprice + Max premium over hashprice). Previously these
        // lived only in decide.ts, so a NiceHash order could be priced above the
        // operator's break-even ceiling with nothing to stop it. The cap is a
        // property of what the OPERATOR is willing to pay, so it must hold
        // regardless of which venue happens to be live.
        const nhFixedCapPh = cfg.max_bid_sat_per_eh_day / 1000;
        const nhDynamicCapPh =
          cfg.max_overpay_vs_hashprice_sat_per_eh_day !== null &&
          state.hashprice_sat_per_ph_day !== null
            ? state.hashprice_sat_per_ph_day +
              cfg.max_overpay_vs_hashprice_sat_per_eh_day / 1000
            : null;
        const nhEffectiveCapPh =
          nhDynamicCapPh !== null ? Math.min(nhFixedCapPh, nhDynamicCapPh) : nhFixedCapPh;
        // The ceiling is about what we EFFECTIVELY pay, so it must be compared
        // fee-inclusive: NiceHash bills its marketplace fee on top of the order
        // price, and hashprice (break-even) is what the hashrate earns. Paying
        // 49,500 at a 3% fee really costs ~50,985. So the cap the ORDER PRICE may
        // reach is capPh / (1 + fee), not capPh.
        const nhFeeMult = 1 + (cfg.nicehash_fee_pct ?? 0) / 100;
        const nhPriceCapPh = nhFeeMult > 0 ? nhEffectiveCapPh / nhFeeMult : nhEffectiveCapPh;
        const nhDesiredCapped =
          evald.nicehashEffectiveSatPerPhDay !== null
            ? Math.min(evald.nicehashEffectiveSatPerPhDay, nhPriceCapPh)
            : null;
        if (
          evald.nicehashEffectiveSatPerPhDay !== null &&
          nhDesiredCapped !== null &&
          nhDesiredCapped < evald.nicehashEffectiveSatPerPhDay
        ) {
          console.info(
            `[nicehash] desired ${Math.round(evald.nicehashEffectiveSatPerPhDay)} clamped to ` +
              `effective cap ${Math.round(nhPriceCapPh)} sat/PH/day (fee-inclusive ceiling ${Math.round(nhEffectiveCapPh)}) ` +
              `(min of maximum ${Math.round(nhFixedCapPh)}` +
              `${nhDynamicCapPh !== null ? `, hashprice+premium ${Math.round(nhDynamicCapPh)}` : ''})`,
          );
        }
        const actions = decideNicehash({
          // Use the seeded/committed provider (boot seed may have overridden the
          // windowed selection on the first tick) so order maintenance matches.
          providerActive: this.activeProvider === 'NICEHASH',
          desiredPriceSatPerPhDay: nhDesiredCapped,
          // Overpay cushion baked into `desired`, so decideNicehash can throttle
          // increases: hold while still above the fill line, raise only when the
          // order has fallen to it (avoids per-tick increases that would keep
          // NiceHash's 10-min decrease lockout permanently reset).
          overpaySatPerPhDay: cfg.overpay_sat_per_eh_day / 1000,
          // #55: hold the price (don't chase up) while the book is rationed.
          rationed: evald.nicehashRationed,
          parkPriceSatPerPhDay: parkPrice,
          order: {
            exists: snapshot.exists,
            orderId: snapshot.orderId,
            currentPriceSatPerPhDay: snapshot.currentPriceSatPerPhDay,
            remainingBtc: snapshot.remainingBtc,
            // We DO track the decrease cooldown now: derive a synthetic
            // last-decrease time from the cooldown-until we learned (from a
            // NiceHash rejection or our own decrease). This holds the daemon's
            // decreases until the cooldown clears instead of hammering the API,
            // and stays in sync with a manual operator edit.
            lastDecreaseAtMs:
              this.nicehashDecreaseCooldownUntilMs !== null
                ? this.nicehashDecreaseCooldownUntilMs - NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS
                : null,
          },
          refillThresholdBtc: cfg.nicehash_refill_threshold_btc,
          refillAmountBtc: cfg.nicehash_refill_amount_btc,
          createAmountBtc: cfg.nicehash_create_amount_btc,
          now: state.tick_at,
        });
        // Surface the NiceHash next action to the dashboard's Next Action card
        // (via /api/provider) so it reflects NiceHash, not a phantom Braiins bid.
        const meaningful = actions.filter((a) => a.kind !== 'NONE');
        const nhActionSummary =
          meaningful.length > 0
            ? meaningful.map((a) => `${a.kind}: ${a.reason}`).join('; ')
            : 'NiceHash order optimal - holding this tick';
        if (this.lastProviderEvaluation) {
          this.lastProviderEvaluation = {
            ...this.lastProviderEvaluation,
            nicehashAction: nhActionSummary,
          };
        }
        const params: NiceHashLiveParams = {
          algorithm: cfg.nicehash_algorithm,
          market: book.market,
          poolId: cfg.nicehash_pool_id,
          marketFactor: book.marketFactor,
          displayMarketFactor: book.displayMarketFactor,
        };
        // #61: the order limit we want set on CREATE/EDIT = the config target,
        // clamped to a whole PH >= 1 (NiceHash floor is 1 PH in 1 PH steps).
        // NiceHash accepts limit decreases (confirmed live), so this converges a
        // larger-than-target order down to the target.
        // #56: while supplementing (ON or unwinding) throttle to the 1 PH floor
        // so NiceHash + the un-parked Braiins bid sum to ~2 PH instead of
        // doubling up; restored to the target automatically once the machine
        // returns to OFF (so NiceHash is never left stuck at 1 PH).
        // BUG (v1.18.15): this used Math.round(), so a 1.5 PH target became 2 PH
        // and the daemon silently forced every order back to 2 - including one the
        // operator had manually created at 1 PH. NiceHash's `limit` is EH with 8
        // decimals (0.00150000 = 1.5 PH), so fractional targets are perfectly
        // legal; the rounding was never needed. Honour the configured value
        // exactly, with a small positive floor so a zero/blank config can't submit
        // an invalid limit.
        // B6: the slab table sizes the order when enabled; otherwise the
        // configured NiceHash target applies.
        const nicehashTargetLimitPh = Math.max(
          0.01,
          this.slabDecision && !this.slabDecision.park
            ? this.slabDecision.targetPh
            : cfg.nicehash_target_hashrate_ph,
        );
        // #A (v1.18.14): do NOT throttle the NiceHash limit during a supplement.
        // Throttling to 1 PH saved nothing (NiceHash bills only for hashrate
        // actually delivered) and it capped recovery, hiding whether the market
        // had healed. Braiins simply tops up the shortfall instead.
        // BUG (v1.18.15): while NiceHash is being PARKED, Braiins un-parks
        // immediately but NiceHash keeps delivering for as long as the price
        // descent takes - one capped 200 sat/PH/day step per 10-minute cooldown,
        // so a large gap can bleed for an hour with BOTH venues billing at once.
        // The order LIMIT has no cooldown and takes effect instantly, so we cut it
        // to the floor the moment NiceHash stops being the active provider. That
        // caps the overlap at ~1 PH instead of the full target while the price
        // walks down to the park level. Restored to the full target automatically
        // when NiceHash becomes active again.
        // B6: park when the market is above the top slab, regardless of which
        // venue is "cheaper" - cheaper-but-still-loss-making is still a loss.
        const nicehashParking =
          this.activeProvider !== 'NICEHASH' || this.slabDecision?.park === true;
        const nicehashDesiredLimitPh = nicehashParking
          ? Math.min(1, nicehashTargetLimitPh)
          : nicehashTargetLimitPh;
        if (nicehashParking && nicehashTargetLimitPh > 1) {
          console.info(
            `[nicehash] parking - limit cut to ${nicehashDesiredLimitPh} PH (from ` +
              `${nicehashTargetLimitPh}) so both venues don't bill in full during the price descent`,
          );
        }

        // v1.18.16: suppress REFILL while backing off from a rejection. Without
        // this the daemon retried a doomed refill every 60 s - 360 failed calls
        // over 2026-08-02/03 (140x 3001 "Insufficient balance", then 220x 5102
        // "Order refill too frequent" once NiceHash rate-limited us). The order
        // keeps running on its existing budget meanwhile; a refill is never
        // urgent to the second.
        const refillBackedOff =
          this.nicehashRefillBackoffUntilMs !== null &&
          state.tick_at < this.nicehashRefillBackoffUntilMs;
        const actionsToRun = refillBackedOff
          ? actions.filter((a) => a.kind !== 'REFILL')
          : actions;
        if (refillBackedOff && actions.some((a) => a.kind === 'REFILL')) {
          const mins = Math.ceil((this.nicehashRefillBackoffUntilMs! - state.tick_at) / 60_000);
          console.info(
            `[nicehash] refill suppressed for ~${mins} min after a rejection` +
              `${this.nicehashRefillBlockReason ? ` (${this.nicehashRefillBlockReason})` : ''}`,
          );
        }

        const nhResults = await executeNicehash(
          svc,
          actionsToRun,
          state.run_mode,
          params,
          nicehashDesiredLimitPh,
        );

        // v1.18.16: arm the back-off on ANY refill rejection, and surface the
        // cause. 3001 "Insufficient balance in account" is an OPERATOR problem -
        // the NiceHash wallet needs topping up - so it must be visible, not
        // buried in a log line repeated 140 times.
        const refillFailure = nhResults.find(
          (r, i) => actionsToRun[i]?.kind === 'REFILL' && r.outcome === 'FAILED',
        );
        if (refillFailure) {
          this.nicehashRefillBackoffUntilMs = state.tick_at + NICEHASH_REFILL_BACKOFF_MS;
          const note = refillFailure.note ?? '';
          this.nicehashRefillBlockReason = /3001|Insufficient balance/i.test(note)
            ? 'NiceHash wallet has insufficient balance - top it up'
            : /5102|too frequent/i.test(note)
              ? 'NiceHash rate-limited the refill (too frequent)'
              : note.slice(0, 160);
          console.warn(
            `[nicehash] REFILL rejected - backing off ${NICEHASH_REFILL_BACKOFF_MS / 60_000} min: ` +
              this.nicehashRefillBlockReason,
          );
          if (this.lastProviderEvaluation) {
            this.lastProviderEvaluation = {
              ...this.lastProviderEvaluation,
              nicehashAction: `NiceHash REFILL blocked: ${this.nicehashRefillBlockReason}`,
            };
          }
        } else if (nhResults.some((r, i) => actionsToRun[i]?.kind === 'REFILL' && r.outcome === 'EXECUTED')) {
          this.nicehashRefillBackoffUntilMs = null;
          this.nicehashRefillBlockReason = null;
        }

        // B1: when a CREATE fails LIVE, don't guess why (the original theory
        // here was "2FA required," but an operator API key with the
        // marketplace order-create permission enabled does NOT get an
        // interactive 2FA prompt - same as Braiins' owner-token path (see
        // migration 0083). Surface NiceHash's ACTUAL rejection instead, so
        // the operator sees the real cause (bad pool id, sub-minimum amount,
        // price/limit rejection, etc.) rather than a guess. Falls through to
        // the auto-generated `nhActionSummary` unless a CREATE specifically
        // failed this tick.
        const createFailure = nhResults.find(
          (r, i) => actions[i]?.kind === 'CREATE' && r.outcome === 'FAILED',
        );
        if (createFailure && this.lastProviderEvaluation) {
          this.lastProviderEvaluation = {
            ...this.lastProviderEvaluation,
            nicehashAction:
              `NiceHash REJECTED order creation - create it manually on the NiceHash ` +
              `website until this is resolved. Reason reported: ${createFailure.note}`,
          };
        }

        // B1: order-expiry countdown. Loud, always-on warning appended to
        // whatever the Next Action text currently says once the order is
        // within `nicehash_order_expiry_alert_days` of expiring - so an order
        // that's about to lapse (and can't be auto-renewed, e.g. because
        // creation needs manual 2FA/verification) never lapses silently.
        // Best-effort: only fires when expiresAtMs was parseable - see the
        // caveat on NiceHashOrderSnapshot.expiresAtMs.
        if (snapshot.exists && this.lastProviderEvaluation) {
          const expiresAtMs = this.lastProviderEvaluation.nicehashOrder?.expiresAtMs ?? null;
          const alertDays = cfg.nicehash_order_expiry_alert_days;
          if (expiresAtMs !== null && alertDays > 0) {
            const msLeft = expiresAtMs - state.tick_at;
            const daysLeft = msLeft / (24 * 60 * 60 * 1000);
            if (daysLeft <= alertDays) {
              const roundedDays = Math.max(0, Math.round(daysLeft * 10) / 10);
              const expiryNote =
                msLeft <= 0
                  ? `⚠️ NiceHash order has EXPIRED - create a new one manually (2FA may block API creation; see above)`
                  : `⚠️ NiceHash order expires in ~${roundedDays}d - refill or renew before it lapses`;
              this.lastProviderEvaluation = {
                ...this.lastProviderEvaluation,
                nicehashAction: this.lastProviderEvaluation.nicehashAction
                  ? `${this.lastProviderEvaluation.nicehashAction} · ${expiryNote}`
                  : expiryNote,
              };
            }
          }
        }

        // #52: record executed NiceHash order/price events into bid_events so
        // the Timeline reflects them alongside Braiins (provider='NICEHASH').
        // nhResults is 1:1 with `actions` (executeNicehash pushes one result
        // per action, in order), so zip by index. Only EXECUTED rows are
        // logged (mirrors the Braiins execute() path; DRY-RUN records nothing).
        // Prices convert sat/PH/day -> sat/EH/day (x1000) to match the column
        // convention the /api serialisation divides back down by.
        await this.recordNicehashBidEvents(
          actions,
          nhResults,
          snapshot.currentPriceSatPerPhDay,
          nicehashDesiredLimitPh,
          state.tick_at,
          state.config.overpay_sat_per_eh_day,
          state.config.max_overpay_vs_hashprice_sat_per_eh_day,
        );

        // Learn / refresh the decrease cooldown so we stop hammering NiceHash
        // and respect manual operator edits. Three sources, in order of trust:
        //   1. DETECTED price drop between ticks (by anyone - manual or daemon):
        //      the price just fell, so a fresh 10-min window starts now. This is
        //      what makes the cooldown show without a failed attempt.
        //   2. Our own just-executed decrease -> a fresh full 10-min window.
        //   3. EXACT "seconds till available" on a rejected decrease -> the
        //      authoritative remaining time; it overrides the estimate.
        let cooldownUntil = this.nicehashDecreaseCooldownUntilMs;

        // (1) Detect a drop vs the last observed price. The daemon's own decrease
        // is excluded below (we baseline lastPrice to the submitted price), so a
        // drop detected here is a manual edit or a market re-price we didn't do.
        const prevPrice = this.nicehashLastPriceSatPerPhDay;
        const curPrice = snapshot.currentPriceSatPerPhDay;
        const priceDropped =
          prevPrice !== null && curPrice !== null && curPrice < prevPrice - 1e-6;
        if (priceDropped) {
          cooldownUntil = Math.max(
            cooldownUntil ?? 0,
            state.tick_at + NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS + NICEHASH_COOLDOWN_SAFETY_MS,
          );
        }

        // (2) Our own executed decrease also starts a fresh window.
        const ourDecreasePrices = actions
          .filter(
            (a) =>
              (a.kind === 'EDIT_PRICE' || a.kind === 'PARK') &&
              a.submitPriceSatPerPhDay !== undefined &&
              curPrice !== null &&
              a.submitPriceSatPerPhDay < curPrice,
          )
          .map((a) => a.submitPriceSatPerPhDay!);
        const executedDecrease =
          state.run_mode === 'LIVE' &&
          ourDecreasePrices.length > 0 &&
          nhResults.some(
            (r) => (r.kind === 'EDIT_PRICE' || r.kind === 'PARK') && r.outcome === 'EXECUTED',
          );
        if (executedDecrease) {
          cooldownUntil = Math.max(
            cooldownUntil ?? 0,
            state.tick_at + NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS + NICEHASH_COOLDOWN_SAFETY_MS,
          );
        }

        // (3) Exact remaining from a rejection overrides the estimate.
        for (const r of nhResults) {
          if (r.cooldownSecondsLeft !== undefined) {
            // NiceHash truncates the remaining seconds ("1" can mean 1.9 s), so
            // honour its figure plus the same margin rather than firing on the
            // exact boundary and being rejected again.
            cooldownUntil =
              state.tick_at + r.cooldownSecondsLeft * 1000 + NICEHASH_COOLDOWN_SAFETY_MS;
          }
        }
        this.nicehashDecreaseCooldownUntilMs = cooldownUntil ?? null;

        // Baseline the last-seen price for next tick's drop detection. After our
        // own executed decrease, use the submitted price so we don't re-detect
        // the daemon's own edit as a fresh manual drop next tick.
        this.nicehashLastPriceSatPerPhDay = executedDecrease
          ? Math.min(...ourDecreasePrices)
          : curPrice;
        if (this.lastProviderEvaluation) {
          this.lastProviderEvaluation = {
            ...this.lastProviderEvaluation,
            nicehashDecreaseCooldownSecondsLeft: nicehashCooldownSecondsLeft(
              cooldownUntil ?? null,
              state.tick_at,
            ),
          };
        }
      } catch (err) {
        console.warn(`[nicehash] order maintenance failed (non-fatal): ${(err as Error).message}`);
      }
    }
  }

  /**
   * #52: persist executed NiceHash actions as bid_events (provider='NICEHASH')
   * so the Timeline shows NiceHash create/edit/park/cancel next to Braiins.
   *
   * Kind mapping onto the existing bid_events vocabulary (no new dashboard
   * glyphs required): CREATE->CREATE_BID, EDIT_PRICE->EDIT_PRICE, PARK->
   * BID_PAUSED (a park idles the order like a pause), CANCEL->CANCEL_BID.
   * REFILL is a free budget top-up, not an order/price change, so it's not
   * logged (it would only add noise to the "order and price changes" feed).
   *
   * NiceHash prices are sat/PH/day; bid_events stores sat/EH/day (the API
   * divides back by 1000), so multiply by EH_PER_PH. The pre-edit price comes
   * from the order snapshot taken this tick.
   */
  private async recordNicehashBidEvents(
    actions: readonly NicehashOrderAction[],
    results: readonly ExecuteNicehashResult[],
    prevPriceSatPerPhDay: number | null,
    desiredLimitPh: number,
    occurredAt: number,
    overpaySatPerEhDay: number,
    maxOverpayVsHashpriceSatPerEhDay: number | null,
  ): Promise<void> {
    const EH_PER_PH = 1000;
    const kindMap: Partial<Record<NicehashOrderAction['kind'], BidEventKind>> = {
      CREATE: 'CREATE_BID',
      EDIT_PRICE: 'EDIT_PRICE',
      PARK: 'BID_PAUSED',
      CANCEL: 'CANCEL_BID',
    };
    for (let i = 0; i < actions.length; i += 1) {
      const a = actions[i]!;
      const r = results[i];
      // Only actually-executed mutations become Timeline rows (matches the
      // Braiins execute() path; DRY-RUN logs but records nothing).
      if (!r || r.outcome !== 'EXECUTED') continue;
      const kind = kindMap[a.kind];
      if (!kind) continue; // REFILL / NONE - not an order/price change
      const isCreate = a.kind === 'CREATE';
      const newPriceSat =
        a.submitPriceSatPerPhDay !== undefined
          ? Math.round(a.submitPriceSatPerPhDay * EH_PER_PH)
          : null;
      // Old price only makes sense on an edit/park (create has no prior price).
      const oldPriceSat =
        !isCreate && prevPriceSatPerPhDay !== null
          ? Math.round(prevPriceSatPerPhDay * EH_PER_PH)
          : null;
      try {
        await this.deps.bidEventsRepo.insert({
          occurred_at: occurredAt,
          source: 'AUTOPILOT',
          kind,
          provider: 'NICEHASH',
          // Reuse the order-id column as a generic venue order id. CREATE has
          // no id yet this tick (like the Braiins CREATE path), so null.
          braiins_order_id: isCreate ? null : (a.orderId ?? null),
          old_price_sat: oldPriceSat,
          new_price_sat: newPriceSat,
          // #D (v1.18.14): stamp the limit on EVERY NiceHash event, not just
          // CREATE. Braiins rows back-fill speed from their CREATE_BID row, but a
          // NiceHash order created before event logging existed has no such row,
          // so the Timeline's Speed column rendered "-" on every edit/park.
          speed_limit_ph: desiredLimitPh,
          amount_sat:
            isCreate && a.amountBtc !== undefined
              ? Math.round(a.amountBtc * 1e8)
              : null,
          reason: `NiceHash · ${a.reason}`,
          overpay_sat_per_eh_day: overpaySatPerEhDay,
          max_overpay_vs_hashprice_sat_per_eh_day: maxOverpayVsHashpriceSatPerEhDay,
        });
      } catch (err) {
        console.warn(`[nicehash] bid_events insert failed: ${(err as Error).message}`);
      }
    }
  }

  getLastResult(): TickResult | null {
    return this.lastResult;
  }

  /** Latest dual-provider evaluation for /api/status. null until the first evaluated tick. */
  getProviderEvaluation(): ProviderEvaluationSnapshot | null {
    return this.lastProviderEvaluation;
  }
}

/**
 * Remaining whole seconds on the NiceHash decrease cooldown, or null when the
 * cooldown is unknown or already elapsed. Kept tiny + pure so both the initial
 * snapshot and the post-execute refresh compute it the same way.
 */
function nicehashCooldownSecondsLeft(untilMs: number | null, nowMs: number): number | null {
  if (untilMs === null) return null;
  const secs = Math.ceil((untilMs - nowMs) / 1000);
  return secs > 0 ? secs : null;
}
