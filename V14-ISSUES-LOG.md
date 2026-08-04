# v1.18.14 issues log (observation period)

Running list of issues seen on the LIVE **v1.18.13** deploy. We are **not** shipping
fixes yet — collecting over a few days, then fixing them all in one v1.18.14 batch.

Status legend: 🔴 open · 🟡 diagnosed (fix known) · 🟢 fixed (staged for v14)

Add new observations under "New / unsorted" at the bottom — a screenshot + timestamp +
what you expected vs what happened is ideal.

---

## #A — Braiins supplement doesn't auto-start when NiceHash delivers < 1 PH  🟡 diagnosed

**Observed (Jul 27):** NiceHash active and cheaper, order delivering only **0.42 PH/s**,
but the Braiins bid stayed **PARKED** — no supplement kicked in. Delivery later bounced
to 1.83 then 1.29 PH/s at the *same* order price (thin, volatile supply at our bid).

**Root cause:** the supplement trigger is wired to the deep-liquidity detector (#55) —
"is there a ≥1 EH block of supply *anywhere* in the book?" In a liquid market there's
almost always 1 EH somewhere at *some* price, so that reads "not rationed" and the
supplement never arms, even while our order under-delivers at our price.

**Proposed fix (for v14):** trigger on NiceHash's **actual delivered hashrate**, not the
deep-liquidity proxy. When NiceHash is the active venue but delivering below ~1 PH,
un-park Braiins to top up; re-park once NiceHash recovers past ~1.5 PH. The gap is
hysteresis so a bouncing delivery figure can't flap the Braiins bid. Leave NiceHash at
its full target limit (throttling the *limit* saves nothing — NiceHash only bills for
delivered hashrate — and it blinded recovery detection). Total then tracks ~1–2 PH, which
matches the "between 1 and 2 is good enough" intent.
(Code for this was drafted and reverted to keep the tree on v1.18.13; ready to re-apply.)

---

## #B — Price oscillation: premature decrease craters delivery, then scrambles back up  🟡 diagnosed

**Reframed by the Jul 27 10:00–10:12 log.** What looked like "runs up aggressively" is
actually a **recovery increase after an over-aggressive decrease**. Sequence (NiceHash
active, order 9d1bb1d4, target/limit 2 PH):

| time (local) | order price | delivered (acceptedCurrentSpeed) | action |
|---|---|---|---|
| 10:00:47 | 49,540 | 0.87 PH/s | — |
| 10:01:51 | 49,540 | 1.29 | — |
| 10:03:51 | 49,540 | 1.83 | — |
| 10:04:47 | 49,540 | **2.01** (full target) | — |
| 10:04:48 | 49,540→**49,340** | — | **DECREASE −200** ("desired −741, more steps to follow") |
| 10:05:47 | 49,340 | 1.68 | — |
| 10:06:55 | 49,340 | 1.35 | — |
| 10:07:48 | 49,340 | 0.99 | — |
| 10:08:47 | 49,340 | 0.42 | — |
| 10:09:47 | 49,340 | 0.30 | — |
| 10:10:48 | 49,340 | **0.24** (collapsed) | — |
| 10:10:49 | 49,340→**49,530** | — | **INCREASE +189** (chasing fill line back up) |
| 10:11:49 | 49,530 | 0.15 | — |
| 10:12:46 | 49,530 | 0.30 | — |

**Root cause:** at 49,540 we were delivering the **full 2 PH target**, but the daemon
still decided to trim toward the depth-aware fill line (~48,800 = fill 48,700 + overpay
100), because current−desired = 741 > the 200 deadband. The fill-line estimate
**underestimated** the price actually needed to sustain 2 PH (the book was thin/volatile —
`rigsCount` bounced 20→0→26→56→0→26→55 between ticks). Cutting 200 sat to save a sliver of
overpay lost almost all delivery (2.01 → 0.24 PH/s), then the capped 200/step decrease +
10-min cooldown made recovery slow, and it had to raise again — the visible "run up."

**Proposed v14 direction: delivery-aware decrease gate.** Do NOT cut the NiceHash price
while it is delivering at/near target — a decrease only makes sense to shed *overpay we
don't need*, and if we're already getting the target the current price is by definition
acceptable (it's ≤ the max-bid cap). Options to combine:
- Gate decreases on delivery: only step down when delivered is comfortably **above**
  target (real slack), never when delivered ≈ target or falling.
- Remember the **last price that delivered target** and treat it as a soft floor — don't
  cut below a level known to fill, absent evidence the cheaper level still fills.
- Keep increases fast (reactivation) — the increase side is fine; the fix is to stop the
  needless decrease that triggers the whole cycle.

This also subsumes the earlier "aggressive run-up" framing: kill the premature decrease and
there's nothing to scramble back from.

**Related — "doesn't depth-awareness already prevent this?" (operator question):** No,
because `cheapestFillableForDepth` derives depth from each order's `acceptedSpeed` = what
that order is *currently being delivered*. That input is:
  1. **Self-inclusive** — our own order's 2 PH at 49,540 is counted in the cumulative
     depth, so "2 PH available by ~48,700" was partly us. Repricing lower doesn't keep it.
  2. **A volatile snapshot** — `rigsCount` churned 20→0→56→0→55 between ticks; the depth
     present at 10:04 was gone by 10:08. Descriptive, not predictive of post-reprice fill.
  3. **Direction-biased** — supply flows to the HIGHEST bidders first, but the calc sums
     from the cheapest up, tallying supply cheaper orders already consume, which isn't ours
     at a lower price. Tends to overstate capture after a cut.

Conclusion: observed delivery (we WERE getting 2 PH at 49,540) is a stronger signal than
the modeled depth price. v14 should prefer the empirical delivery — hence the delivery-
aware decrease gate — and optionally down-weight/again-verify `acceptedSpeed`-derived depth
when `rigsCount` is churning. (Ties into #55.)

---

## #C — Ocean-received vs paid-for reconciliation + variance alert  🟡 diagnosed (HIGH VALUE — operator flagged important)

**Goal (operator, Jul 27):** compare **AVG OCEAN** (hashrate Ocean actually credits) against
the **implied delivered** hashrate we *paid for* — derived from sats consumed on **both**
NiceHash and Braiins — and **alert on any sustained variance**. The gap is the real economic
loss (rejections / routing / stale shares / latency); this also gives the "implied NiceHash
rejection" that #51 deferred (NiceHash has no per-order reject counter, so it must be
inferred this way).

**TWO EXPLICIT VERIFICATION CHECKS (operator framing — chain of custody for the spend):**
`sats spent → (÷ price) → hashrate paid for  [CHECK 1]  → speed at pool → Ocean .nice credited  [CHECK 2]`

- **CHECK 1 — sats vs order price vs hashrate (billing integrity).**
  `implied_paid_PH = Δnicehash_consumed_sat / (order_price_sat_per_PH_day × Δt_days)`.
  Verify it matches NiceHash's reported **"speed paying"**. Divergence where sats imply MORE
  speed than delivered = over-billing for the price we set. (Braiins analogue: the existing
  consumed-sat → delivered-PH counter.)
- **CHECK 2 — delivery to Ocean under the `.nice` worker (independent oracle).**
  Compare NiceHash **"speed at pool"** ↔ Ocean's credited hashrate for the **`.nice`** worker
  over a matched window. Ocean `.nice` < NiceHash at-pool ⇒ hash not fully landing/credited.

Both are alertable independently, so a leak at either stage is isolated (billing vs delivery).

**Formula (per window):**
- Braiins implied-delivered PH = `Δprimary_bid_consumed_sat × 86_400_000 / (bid_sat_per_PH_day × Δt_ms)`
  (this is already the counter-derived "delivered" the stats card uses — the amber line).
- NiceHash implied-delivered PH = `Δnicehash_consumed_sat / (order_price_sat_per_PH_day × Δt_days)`,
  `Δt_days = Δt_ms / 86_400_000`.
- **Total paid-for PH** = Braiins + NiceHash (per tick, then window-averaged).
- **Variance / effective loss %** = `(paid_for − ocean_received) / paid_for × 100`.
  Positive = paying for more than Ocean receives (loss); this is the implied rejection.

**Alert design:** raise a variance alert when effective-loss % stays above a **configurable
threshold** (e.g. default ~10%) for a **sustained window** (e.g. 15–30 min), using the
existing alerts pipeline (like the below-floor / zero-hashrate alerts). Clear it when it
recovers. Also surface the number on the dashboard (a tile "PAID vs OCEAN" and/or the
implied-rejection line from #51).

**Data availability:** everything needed is already captured in `tick_metrics` as of
v1.18.13 — `primary_bid_consumed_sat`, `nicehash_consumed_sat`, `our_primary_price_...`,
NiceHash order price (via events), `ocean_hashrate_ph`, `active_provider`. So this is mostly
a stats-route + alert + tile change, no new capture.

**BETTER — NiceHash reports it natively (operator, Jul 27 "Order history chart"):** we do
NOT need to infer the NiceHash side from sats. NiceHash's per-order stats API (the source of
their Order-history chart) exposes, per time bucket:
  - **speed paying** (what we're billed for) — e.g. 0.0006 EH/s
  - **speed at pool** (what NiceHash delivered to Ocean's stratum) — e.g. 0.0009 EH/s
  - **delta %** (can be POSITIVE = over-delivery / "extra rewards", e.g. +50.42%)
  - a full **rejection breakdown**: rejected-at-pool, timed-out, stale, target, duplicate,
    ntime, other, worker.
So the NiceHash side becomes a **direct read**, and the audit splits into two independent
gaps, each alertable:
  1. **paying → at-pool** = NiceHash-side loss (their reject breakdown explains WHY).
  2. **at-pool → Ocean-credited** = pool/routing/measurement gap (≈0 if NiceHash's "at pool"
     matches Ocean's stratum view; a persistent gap points at Ocean-side or config).
Direction matters: delta can be **positive** (extra rewards), so show signed variance, don't
assume loss. Braiins side still comes from its consumed-sat counter vs Ocean.

**v14 research task:** identify + wire the NiceHash order-stats endpoint (the one behind the
web "Order history chart" — per-order speed-at-pool / speed-paying / rejects, likely
`GET /main/api/v2/hashpower/order/{id}/stats...`). Capture speed-at-pool, speed-paying and
the reject buckets per tick into `tick_metrics` (new nullable columns) so the reconcile +
alert can read authoritative NiceHash numbers instead of inferring.

**TRUST BUT VERIFY — don't take NiceHash's self-reported delta at face value (operator,
Jul 27 "Detailed information"):** NiceHash showed delta **0.00%** / "rejects 0.0000 EH/s"
for the selected timespan, BUT:
  - **It's rounding, not zero.** Same row shows **10 reject shares + 1 timed-out share** in
    the timespan — real losses just round to 0.0000 at EH scale. The audit MUST use the
    **share counts**, not the rounded EH speeds, at these tiny hashrates.
  - **NiceHash only measures up to its own handoff.** "Speed at pool" is NiceHash's view at
    the stratum handoff; it does NOT know what Ocean's TIDES actually credits. A NiceHash
    "0% loss" says nothing about Ocean-side accounting.
  - **Independent oracle = Ocean per-WORKER hashrate.** The order routes to Ocean under the
    worker identity `bc1qh4akdjpc….`**`.nice`** (seen in daemon logs / order.pool.username).
    Ocean exposes per-worker hashrate, so the authoritative gap #2 check is:
    **NiceHash "speed at pool"  ↔  Ocean credited hashrate for the `.nice` worker.**
    Agreement ⇒ NiceHash self-report trustworthy; Ocean `.nice` < NiceHash at-pool ⇒ a real
    gap NiceHash structurally cannot show. This is the verification to build, not just
    re-displaying NiceHash's own numbers.
  - **Window matters:** last-5-min delta was +33% (at-pool 0.0008 > paying 0.0006) while the
    longer timespan netted ~0% — confirms the reconcile must compare over a matched rolling
    window, and should surface SIGNED variance both directions.

**v14 task (added):** pull Ocean **per-worker** hashrate for the `.nice` worker (Ocean
`/user_hashrate` or worker breakdown) and reconcile it against NiceHash's order speed-at-pool
+ our billed speed. Alert when Ocean-credited `.nice` diverges from NiceHash's claimed
delivery beyond a threshold over a sustained window.

**Caveats to design around:**
- **Timing windows:** Ocean's `hashrate_300s` is a 5-min sliding average; billed hashrate is
  near-instant. Compare both over the SAME window (e.g. rolling 15–30 min) so lag doesn't
  fake a variance. Don't alert on short spikes.
- **Attribution:** when NiceHash is active Braiins is parked (≈0 billed) and vice-versa;
  during a supplement (#A) both bill. Sum per-tick using `active_provider` + both counters.
- **Baseline loss is normal:** healthy operation still loses a few % (routing/stale). Set the
  alert threshold above that baseline so it only fires on genuine problems.
- **NiceHash spend granularity:** `payedAmount` moves in tiny increments; use a longer window
  (≥15 min) for a stable NiceHash implied-delivered figure.

(Supersedes the old "#C implied rejection not shown" framing — same computation, now the full
reconcile + alert feature.)

---

## #D — Timeline: NiceHash rows show blank Speed column  🟡 diagnosed

**Observed (Jul 27):** Timeline now lists NiceHash edit-price events correctly (badge,
price before/after, Δ price all populate — #52 working live), but the **Speed** column is
"—" on every NiceHash row.

**Root cause:** the #52 recorder stores `speed_limit_ph = null` on NiceHash EDIT_PRICE /
PARK events (only CREATE carries the limit). Braiins rows back-fill speed from the order's
original CREATE_BID via the flat-history coalesce, but NiceHash order `9d1bb1d4` was created
2026-07-20 — before v1.18.13 could log a create event — so there's no create row to
back-fill from, and the column stays blank. Cosmetic (the limit is a steady 2.00 PH), not
data loss.

**Proposed v14 fix:** stamp the order's current limit (`snapshot.limitPh`) onto every
NiceHash bid_events row (create / edit / park) in `recordNicehashBidEvents`, so the Speed
column always populates without relying on a back-fill from a create event that may predate
logging. One-line change per event.

---

## #E — "NiceHash fill-line dust floor" config is silently ignored  🟢 confirmed bug (fix known)

**Observed (Jul 27):** operator set **NiceHash fill-line dust floor = 100 PH/s** (Config)
expecting sub-100-PH trickle orders to be excluded when finding the fill line, but the fill
line still anchors to a level **below** that threshold (fill line 48,660; order delivering
only 0.24 PH/s).

**Confirmed root cause** (`packages/daemon/src/controller/evaluate-providers.ts` ~L178–182):
```
const fillLine = targetPh > 0
  ? cheapestFillableForDepth(orders, targetPh, marketFactor)          // NO minDeliveredPh
  : lowestFillingPrice(orders, marketFactor, { minDeliveredPh: cfg.nicehash_min_delivered_ph });
```
NiceHash target is 2 PH, so `targetPh > 0` is always true → the depth-aware branch always
runs, and it is **never passed `minDeliveredPh`**. `cheapestFillableForDepth` only has the
phantom guard (rigsCount ≤ 0 → 0), not the dust floor. So `nicehash_min_delivered_ph` (the
"dust floor" config, 100 in this setup) does nothing whenever a target is set — i.e. always.
The fill line sums every delivering order from the cheapest up (incl. 0.1–0.8 PH scraps)
until cumulative ≥ target, so scraps set the anchor.

**Proposed v14 fix:** thread `minDeliveredPh` into `cheapestFillableForDepth` and skip orders
delivering ≤ the dust floor when accumulating cumulative depth AND when choosing the anchor
price — in BOTH the depth path and the fallback. Add a unit test with a 100-PH floor over a
scrappy book. **Synergy with #B:** honoring the floor raises the fill line toward real
non-dust supply, which reduces the premature-decrease-into-scraps behavior.

**Note to confirm:** is 100 PH/s the intended floor value, or a mis-set default? #54 shipped
the default at 0.1 PH/s. Either way the fix is to HONOR whatever is configured; but worth a
sanity check on whether 100 makes the book too sparse for a 2 PH target (few orders deliver
>100 PH individually).

**Operator clarification (Jul 27) — PER-ORDER vs CUMULATIVE semantics mismatch:** operator
set 100 PH (= 0.1 EH) reasoning "0.1 EH is ~1% of the ~10 EH total book, drop the bottom
1%." But `nicehash_min_delivered_ph` is a **per-order** floor ("ignore any single order
delivering ≤ X"), NOT a cumulative-supply percentile. On the live book individual orders
deliver ~0.1–126.5 PH each and almost all are < 100 PH, so a 100-PH per-order floor would
discard nearly the whole book and anchor to the one >100-PH order (fragile). Once #E is fixed
this would bite hard.
**DECISION (operator, Jul 27): implement BOTH filters** — high volatility warrants layering
them. They stack in this order inside the depth-aware fill-line calc:
  1. **Per-order dust floor** (existing field, fix #E to actually apply it in
     `cheapestFillableForDepth`): drop any INDIVIDUAL order delivering ≤ the floor. Keep the
     default SMALL (~0.1 PH); operator should revert 100 → 0.1 now that it will take effect.
  2. **NEW: cumulative bottom-N skip** (`nicehash_fill_skip_bottom_eh`, default 0 = off): on
     the survivors, sorted cheapest→dearest, skip the first N of CUMULATIVE delivered supply
     before counting toward the target, so the anchor sits above the thin cheap tail. This
     is the operator's "ignore the lowest ~0.1 EH / 1% of supply" intent.
Applied per-order-filter → cumulative-skip → then accumulate to target. Net: the fill line
lands on real, reliable supply and stops whipsawing on the volatile bottom slice — the
direct antidote to #B (anchoring into scraps then premature-decreasing). Add unit tests for:
per-order floor only, cumulative skip only, and both together on a scrappy/volatile book.

---

## #F — Cost tiles measure NiceHash-accepted, not Ocean-credited → understate true cost  🟡 diagnosed (LIVE EVIDENCE for #C)

**Observed (Jul 27, 13:19, 3h window):** AVG NICEHASH **2.43 PH/s**, AVG OCEAN **1.37 PH/s**,
AVG COST DELIVERED **52,004 sat/PH/day**, AVG COST VS HASHPRICE **+2,051**, order price 48,590
(dropping −1,522/step). Operator doubts the metrics.

**Analysis:**
- **~44% gap** between NiceHash accepted (2.43) and Ocean credited (1.37) — too large over a
  3h average to be just Ocean's 5-min lag. Prime evidence of the #C leak (paying for hash
  that isn't landing/credited at Ocean).
- **AVG COST DELIVERED uses NiceHash-accepted delivery as the denominator** (the
  `nicehash_delivered_ph` = acceptedCurrentSpeed captured in #48/#49). So it ≈ the
  window-average *price* (52k > current 48.6k because price was higher earlier) — it answers
  "cost per PH NiceHash says it gave me," NOT "cost per useful PH."
- **True cost per Ocean-credited PH ≈ 52,004 × (2.43 / 1.37) ≈ 92,000 sat/PH/day.** vs
  hashprice (~49,953 implied) that's **~+42,000 above break-even**, not +2,051 — i.e. at this
  loss rate NiceHash may be uneconomic, which the current tiles completely hide.

**Proposed v14 fix (folds into #C):** add a **cost-per-Ocean-PH** and **vs-hashprice-on-Ocean**
computation (spend ÷ Ocean-credited delivery) ALONGSIDE the NiceHash-accepted versions, and
make the headline "AVG COST DELIVERED / VS HASHPRICE" reflect the Ocean-credited (economically
real) number — or show both clearly labelled. The 44% gap itself is the #C variance to verify
via the `.nice` per-worker check + NiceHash speed-at-pool (rule out Ocean lag / other workers
before treating it as pure loss).

**Reopens #50** (the "AVG NICEHASH vs AVG OCEAN gap is expected" conclusion was too
sanguine — a sustained 44% gap is material and must be reconciled + alerted, not shrugged off).

---

## DECISION (Jul 27, post-v1.18.14 build): Checks 1 & 2 POSTPONED to v15

**New evidence — the gap flipped sign.** Later reading on the same 3h window:
AVG NICEHASH **1.23** PH/s vs AVG OCEAN **1.31** PH/s — Ocean now credits slightly MORE
than NiceHash reports delivering. Earlier it was 2.43 vs 1.37 (~44% "loss"). A structural
delivery leak cannot invert; this is consistent with a timing/measurement artifact (Ocean's
5-min trailing average compared against a NiceHash figure that was collapsing 2.43 -> 0.24
during that exact window — the #B incident). So the 44% was largely transient, NOT proof of
a persistent leak.

**Therefore:** v1.18.14 ships with the MEASUREMENT (Ocean-credited cost + signed variance
tile) but WITHOUT:
  - CHECK 1 (billing integrity: Δsats ÷ price vs NiceHash "speed paying")
  - CHECK 2 proper (NiceHash "speed at pool" vs Ocean per-worker `.nice` credit)
  - the sustained-variance ALERT
Rationale: the variance tile is the DETECTOR; Checks 1 & 2 are DIAGNOSTICS that isolate
which stage leaked (billing vs delivery). Building them costs two unverified API
integrations (NiceHash per-order stats endpoint + Ocean per-worker breakdown) and is only
justified if the variance stays materially positive over a long window.

**Trigger to build them (v15):** variance tile sustained >10% on a 24h+ window (use long
windows - short ones are dominated by Ocean's 5-min lag, as this flip demonstrates). If it
hovers near 0 / oscillates in sign, no leak exists and these stay closed.

**CAVEAT RESOLVED (Jul 27, Ocean Workers page):** the payout address has exactly one active
worker - `nice` (1801.4 Th/s @60s, 1303.5 Th/s @3hr), and **Total == nice** to the decimal.
`braiins` is Offline (0.00 Th/s, last share 00:09) because Braiins is parked while NiceHash
is the active provider - the intended #44 park behaviour. So Ocean's ACCOUNT-level hashrate
IS the `.nice` worker figure: v1.18.14's variance tile needs no per-worker API to be valid,
and CHECK 2 is effectively satisfied by the existing account-level comparison **as long as
`nice` remains the only online worker**. Re-check this if a second worker ever appears (e.g.
during a Braiins supplement, when BOTH venues deliver - then account-level covers both, which
is still correct for the blended variance but no longer isolates NiceHash).

**Cross-validation:** Ocean 3hr 1303.5 Th/s = 1.30 PH/s vs the AVG OCEAN tile's 1.31 PH/s -
the dashboard reads Ocean correctly. And NiceHash 1.23 PH/s vs Ocean 1.30 credited confirms
no delivery leak at this time.

**Also still open for v15:** #C's Ocean-credited P&L wiring beyond the tiles, plus CHECK 1
(billing integrity) which the account-level comparison does NOT cover - it can only tell you
hashrate reached Ocean, not whether NiceHash billed you for more than it delivered.

---

## #G — Supplement buys Braiins hash at/above break-even (no economic gate)  🔴 v15, real money

**Observed (Jul 27, 17:09, still on v1.18.13):** supplement fired, Braiins un-parked and
raised its bid 49,005 -> **51,883** sat/PH/day while NiceHash was at **48,709** (NiceHash
3.30% cheaper) and hashprice ~50,700. Braiins delivered 0.76 PH/s of its 1.00 cap; NiceHash
1.65 PH/s (total ~2.4 PH, ABOVE the 2 PH target).

**Two faults:**
1. **No economic gate.** The supplement asks only "is NiceHash short?", never "is the
   supplemental hash worth buying?". Here it bought Braiins at ~51,883 vs hashprice ~50,700
   - i.e. supplementing at a LOSS, while the cheaper venue was already running.
2. **No shortfall sizing.** It un-parked a full 1 PH Braiins bid while NiceHash was already
   delivering 1.65 of the 2 PH target - only ~0.35 PH was actually needed, so we overshot to
   2.4 PH and paid the premium on the excess.

**v1.18.14 partially helps:** the supplement now fires on delivered PH (<1.0), and NiceHash
was at 1.65, so the delivery path would NOT have fired here. BUT `rationed` still
force-enables the supplement regardless of delivery, so this exact case can still occur.

**Proposed v15 fix:**
  - **Economic gate:** only supplement when the Braiins effective price is <= hashprice (or
    hashprice + a small configurable margin). Never buy top-up hash above break-even - a
    shortfall is cheaper to tolerate than negative-margin hash.
  - **Size to the shortfall:** set the Braiins supplement bid's speed limit to
    `max(0, target - nicehash_delivered)` rather than the full Braiins target, so total lands
    near target instead of overshooting.
  - **Make `rationed` respect delivery:** don't force the supplement ON when NiceHash is
    already delivering near target, even if the book reads rationed.

## #H — VERIFY: is the hashprice cap being honoured? (probably yes)  🟡 needs one data point

**Operator report:** "ignoring its max overpay cap based on hashprice" (Max premium over
hashprice = 1,099; Maximum = 55,000; bid went to 51,883).

**Code check:** `decide.ts` DOES apply it - `targetPrice = min(desiredBid, effectiveCap)`,
`effectiveCap = min(max_bid_sat_per_eh_day, hashprice + max_overpay_vs_hashprice)`. The bid
decomposes exactly as `fillable 51,784 + overpay 99 = 51,883` and was NOT clamped, which
implies `hashprice >= 50,784` at that tick (plausible - the 3h avg implied ~50,300).

**To confirm:** read the current hashprice on the dashboard. If hashprice >= ~50,784 the cap
is working as designed and this is a non-issue (the cap simply wasn't binding). If hashprice
is materially BELOW that, it IS a bug - investigate the sat/PH vs sat/EH unit conversion in
the `effectiveCap` computation (config stores sat/EH/day; hashprice is converted x1000).
Note this interacts with #G: even when the cap is honoured, a bid just under
`hashprice + 1,099` is still above break-even, which is exactly what #G's economic gate
should prevent for SUPPLEMENT bids.

---

## New / unsorted

_(add observations here — screenshot + time + expected vs actual)_

---

# v1.18.16 BACKLOG (from Bugs.docx, 2026-07-27) - NOT in v1.18.15

Two of the reported bugs ARE fixed in v1.18.15 (target forced to 2 PH; both venues
billing during the park descent). The rest are logged here, unfixed, with root-cause
notes so the next session can implement them directly.

## B1 - NiceHash order creation blocked by 2FA  🔴 needs design
Order expires in ~10 days; the daemon shows CREATE under Next Action but cannot execute
it - NiceHash appears to require 2FA/OTP for order creation. Operator had to create the
order manually.
FIX: the daemon cannot supply an OTP, so (a) detect the failure explicitly and surface a
LOUD alert + Next Action text "create the NiceHash order manually - 2FA required", and
(b) add an expiry-countdown alert (order.endTs minus now < N days) so this never lapses
silently. Also confirm whether NiceHash's API supports an order-create scope that bypasses
2FA for API keys - if so, document the key permission needed.

## B2 - Lifetime P&L excludes EXPIRED NiceHash orders  🔴 real money, understates spend
P&L counts only the CURRENT order's payedAmount, so a completed/expired order's spend
vanishes and the position reads more profitable than it is.
FIX: fetch and sum payedAmount across ALL NiceHash orders in the P&L window (the API
lists historical orders), mirroring the Braiins closed-bids cache. Persist per-order
terminal spend so it survives order rotation.

## B3 - Cost of purchase excludes NiceHash's 3% fee  🟡 verify then fix
Operator: weighted-average price should be divided by 97% (i.e. x1/0.97) to reflect the
fee-inclusive cost. Timeline shows NiceHash price mostly hovering above 49,000.
FIX: confirm whether payedAmount already includes the marketplace fee. If NOT, multiply
NiceHash spend by (1 + nicehash_fee_pct/100) everywhere cost is derived (AVG COST
DELIVERED, cost-per-Ocean-PH, P&L). v1.18.15 applies the fee to the price CEILING only -
the cost/accounting side still needs this.

## B4 - Chart: NiceHash delivered + rejection series missing  🟡
Only Braiins appears on the Hashrate chart. Add (a) a NiceHash delivered line from
tick_metrics.nicehash_delivered_ph (captured since 0126) and (b) a NiceHash rejection
series, plus an alert on major rejections. NiceHash exposes per-order reject/stale counters
via its order-stats endpoint (see #C) - capture them into tick_metrics first.

## B5 - Ocean hashrate not reconcilable to Braiins + NiceHash spend  🟡
Superset of #C. Once B3 is settled, re-check that (Braiins spend + NiceHash spend) / Ocean
credited reconciles; the variance tile + hash-loss alert added in v1.18.15 are the harness.

## B6 - NEW FEATURE: slab-based cheap mode across BOTH providers  🔵 design ready
Replace the current Braiins-only cheap mode with a provider-agnostic, configurable
slab table keyed on (effective price INCLUDING fees) as a % of hashprice. Operator's table:
    < 100%      -> 3 PH
    100 - 101%  -> 2.5 PH
    101 - 102%  -> 2 PH
    102 - 103%  -> 1.5 PH
    103 - 104%  -> 1 PH
    > 104%      -> PARK
Applies to whichever venue is cheaper (the single-active winner). Slabs must be operator-
editable (store as JSON in config, like dashboard_tiles). This supersedes
cheap_target_hashrate_ph / cheap_threshold_pct / cheap_sustained_window_minutes - keep a
migration path. Note it also subsumes the "park when uneconomic" behaviour, which is
currently absent: today nothing parks when BOTH venues are above break-even.

---

# v1.18.17 BACKLOG (observed on LIVE v1.18.15, 2026-08-03)

## B7 - Order CREATE was failing because "NiceHash order budget" = 0  🟢 ROOT CAUSE FOUND
Config had `nicehash_create_amount_btc = 0`. The schema allows 0 (`z.number().nonnegative()`)
and it is POSTed verbatim as `amountBtc: 0`. NiceHash's minimum is **0.001 BTC** (their Buy
panel: "Min: 0.001"), so every CREATE was rejected. This - NOT 2FA - is the 2026-07-30
"daemon cannot create a new order" incident.
OPERATOR FIX (no deploy needed): set NiceHash order budget to >= 0.001 (0.003 matches the
current order size).
CODE FIX (in tree, NOT yet in the v1.18.16 zip - needs verify + repackage): `decide-nicehash.ts`
now exports `NICEHASH_MIN_ORDER_BTC = 0.001` and emits a NONE with an operator-readable reason
instead of firing a CREATE/REFILL that can only 400.

## B8 - REFILL failing despite sufficient balance  🔴 NEEDS THE ERROR LINE
Order 5fb93eeb at 98.1% spent, remaining 0.00005714 BTC, threshold 0.0003, refill amount
0.001, wallet balance 0.00280808 BTC. Every precondition for a refill is met and the amount
clears NiceHash's 0.001 minimum, so config alone does not explain it.
HYPOTHESIS TO TEST (do not assume - the 2FA guess already cost us): NiceHash may refuse
refills on an order this close to completion / with ~1h of budget left. If confirmed, the fix
is to raise `nicehash_refill_threshold_btc` well above 0.0003 so the top-up fires much earlier.
NEEDED: the `[nicehash] LIVE REFILL FAILED ...` log line with NiceHash's actual error body.

## B9 - UPTIME reads 56.9% while Ocean delivery looks continuous  🔴 investigate
24h window, 2026-08-03. Dashboard UPTIME 56.9%, yet the Ocean "received" line on the chart is
essentially continuous across the same window. Uptime has been provider-aware since v1.18.13
(credits whichever venue delivered), so a NiceHash-active stretch should count as up.
CHECK: whether `tick_metrics.nicehash_delivered_ph` is actually populated on those ticks - it
is written ONE TICK BEHIND from the previous evaluation, and is NULL on any tick where the
order lookup failed. A run of NULLs would silently read as downtime. Also verify the
`>= 0.05 PH/s` floor isn't excluding legitimate low-delivery ticks.

## B10 - Hashrate reconciliation off on the 24h view  🟡 partly a known v15 artifact
Observed: AVG BRAIINS 1.46 + AVG NICEHASH 1.65 = 3.11 PH/s paid-for vs AVG OCEAN 2.31 PH/s
credited => ~26% apparent loss. BUT on v1.18.15 the AVG NICEHASH tile still shows the LIVE
accepted speed, not a duration-weighted range average, so the two are NOT comparable and the
sum is invalid. v1.18.16 fixes exactly this (duration-weighted, zero-delivery ticks included
in the denominator).
ACTION: re-measure this on v1.18.16 before treating it as a real leak. The July month-level
reconciliation came out at only -2.4% variance, which argues against a structural 26% loss.

## B11 - AVG OCEAN disagrees with Ocean's own 24h average  🟡
Dashboard AVG OCEAN 2.31 PH/s vs Ocean's own "Hashrate Average / 24 hrs" 2142.9 Th/s
(2.14 PH/s) - about 8% high. Both claim to be 24h averages.
CHECK: our figure is duration-weighted over tick_metrics rows within the range; Ocean's is
their own rolling window with different sampling. Reconcile the window boundaries and confirm
we are not double-counting ticks with long `dur` (restart gaps) - the 5-min `dur` cap applies
to the uptime numerator but NOT to the hashrate averages.

## B8 RESOLVED (2026-08-03 log, 10,000 records 02 Aug 01:27 -> 03 Aug 10:46)
NiceHash returned the exact causes - no guessing needed:
  * **3001 "Insufficient balance in account"** x140 - the NiceHash wallet ran dry, so the
    0.001 BTC refill genuinely could not be funded.
  * **5102 "Order refill too frequent"** x220 - the daemon retried the doomed refill EVERY
    TICK, so NiceHash rate-limited it. 360 failed calls for one underlying problem.
  * **5061 price cooldown** x46 - now reporting "Seconds till available: **7**", not 1, so the
    5 s safety margin was too small.
FIXED (v1.18.16): REFILL backs off 15 min on ANY rejection and surfaces the reason in Next
Action ("NiceHash wallet has insufficient balance - top it up"); cooldown safety margin
raised 5 s -> 15 s. Both verified (209/209 tests, clean build).
OPERATOR ACTION: keep the NiceHash wallet funded; the alert will now say so explicitly.
