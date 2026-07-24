-- #dual-provider: move the NiceHash / dual-provider tunables into the
-- live-editable config table so they can be changed from the dashboard
-- Config page (no rebuild). Credentials (org id / key / secret) stay in
-- the environment - they're set-once and sensitive. All additive columns
-- with safe defaults, so an existing install upgrades cleanly.
ALTER TABLE config ADD COLUMN nicehash_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN nicehash_algorithm TEXT NOT NULL DEFAULT 'SHA256ASICBOOST';
ALTER TABLE config ADD COLUMN nicehash_market TEXT NOT NULL DEFAULT 'BTC';
ALTER TABLE config ADD COLUMN nicehash_pool_id TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN provider_switch_threshold_pct REAL NOT NULL DEFAULT 3.25;
ALTER TABLE config ADD COLUMN provider_switch_sustained_window_minutes INTEGER NOT NULL DEFAULT 10;
ALTER TABLE config ADD COLUMN nicehash_min_delivered_ph REAL NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN braiins_fee_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN nicehash_fee_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN nicehash_target_hashrate_ph REAL NOT NULL DEFAULT 1;
ALTER TABLE config ADD COLUMN nicehash_create_amount_btc REAL NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN nicehash_refill_threshold_btc REAL NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN nicehash_refill_amount_btc REAL NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN park_margin_sat_per_ph_day REAL NOT NULL DEFAULT 5000;
