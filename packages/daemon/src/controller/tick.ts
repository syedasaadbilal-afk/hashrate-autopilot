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
import { decideNicehash } from './decide-nicehash.js';
import { evaluateProviders, type EvaluateProvidersResult } from './evaluate-providers.js';
import { execute, type ExecuteDeps } from './execute.js';
import { executeNicehash } from './execute-nicehash.js';
import { gate } from './gate.js';
import { observe, type ObserveDeps } from './observe.js';
import { computeParkPrice } from './park.js';
import { decidePauseEvent } from './pause-events.js';
import type { Provider, ProviderSelectState } from './provider-select.js';
import type { NiceHashLiveParams, NiceHashService } from '../services/nicehash-service.js';
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
   * #dual-provider: epoch-ms until NiceHash's 10-min price-DECREASE cooldown
   * clears. Learned from (a) our own successful decreases and (b) the EXACT
   * "seconds till available" NiceHash returns on a rejected decrease - the
   * latter also captures a MANUAL operator edit that reset NiceHash's timer
   * without the daemon seeing it. Gates the daemon's own decreases so it stops
   * hammering the API, and feeds the remaining-seconds shown in Next Action.
   */
  private nicehashDecreaseCooldownUntilMs: number | null = null;

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
      overpaySatPerPhDay: cfg.overpay_sat_per_eh_day / 1000,
      braiinsFeePct: cfg.braiins_fee_pct,
      nicehashFeePct: cfg.nicehash_fee_pct,
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
        const actions = decideNicehash({
          // Use the seeded/committed provider (boot seed may have overridden the
          // windowed selection on the first tick) so order maintenance matches.
          providerActive: this.activeProvider === 'NICEHASH',
          desiredPriceSatPerPhDay: evald.nicehashEffectiveSatPerPhDay,
          // Overpay cushion baked into `desired`, so decideNicehash can throttle
          // increases: hold while still above the fill line, raise only when the
          // order has fallen to it (avoids per-tick increases that would keep
          // NiceHash's 10-min decrease lockout permanently reset).
          overpaySatPerPhDay: cfg.overpay_sat_per_eh_day / 1000,
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
        const nhResults = await executeNicehash(
          svc,
          actions,
          state.run_mode,
          params,
          cfg.nicehash_target_hashrate_ph,
          snapshot.limitPh,
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
            state.tick_at + NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS,
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
            state.tick_at + NICEHASH_DEFAULT_PRICE_DECREASE_COOLDOWN_MS,
          );
        }

        // (3) Exact remaining from a rejection overrides the estimate.
        for (const r of nhResults) {
          if (r.cooldownSecondsLeft !== undefined) {
            cooldownUntil = state.tick_at + r.cooldownSecondsLeft * 1000;
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
