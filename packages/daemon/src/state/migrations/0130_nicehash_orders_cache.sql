-- B2: persistent cache of TERMINAL (CANCELLED/COMPLETED/DEAD/EXPIRED)
-- NiceHash orders' payedAmount, mirroring closed_bids_cache (0026) for the
-- Braiins side. A terminal order's payedAmount is final, so we store it
-- once and never re-read it; the currently-active order's spend is always
-- read live from the order snapshot.
--
-- Fixes B2: lifetime P&L previously counted only the CURRENT order's
-- payedAmount (via the provider evaluation snapshot), so a completed or
-- expired order's spend vanished from the figure entirely once a new order
-- replaced it - understating true lifetime spend.
CREATE TABLE nicehash_orders_cache (
  nicehash_order_id TEXT PRIMARY KEY,
  payed_amount_sat INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX idx_nicehash_orders_cache_last_seen_at
  ON nicehash_orders_cache (last_seen_at);
