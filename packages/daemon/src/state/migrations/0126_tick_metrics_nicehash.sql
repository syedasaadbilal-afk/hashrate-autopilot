-- #48/#49/#51: capture per-tick NiceHash delivery + spend + which provider was
-- active, so the tuning stats (UPTIME, AVG COST DELIVERED, VS HASHPRICE) and the
-- rejection audit can blend NiceHash alongside Braiins instead of reading Braiins
-- only. One tick behind (written from the previous tick's order snapshot), the
-- same lag the rest of the dual-provider data flow already uses.
--
--   active_provider        - 'BRAIINS' or 'NICEHASH' at this tick (which venue
--                            was live). NULL on rows predating this migration.
--   nicehash_delivered_ph  - NiceHash order's accepted/delivered speed, PH/s.
--   nicehash_consumed_sat  - NiceHash order's cumulative spend (payedAmount), sat.
--                            Per-tick deltas give the authoritative NiceHash spend,
--                            mirroring primary_bid_consumed_sat on the Braiins side.
--
-- Additive + nullable, so existing rows and the Braiins-only path are unchanged.
-- Each ALTER is independent; none of the columns exist yet, so all three apply.
ALTER TABLE tick_metrics ADD COLUMN active_provider TEXT;
ALTER TABLE tick_metrics ADD COLUMN nicehash_delivered_ph REAL;
ALTER TABLE tick_metrics ADD COLUMN nicehash_consumed_sat REAL;
