-- #dual-provider / #55: deep-liquidity threshold (EH/s) for the NiceHash
-- rationing check. When the book's cumulative delivered supply never reaches
-- this, the market is treated as rationed - the daemon stops chasing the price
-- up into thin scraps and lets Braiins supplement the shortfall. Default 1 EH.
--
-- Additive + NOT NULL DEFAULT, so existing rows read the default. Safe to
-- re-apply (the migration runner tolerates a duplicate-column error).
ALTER TABLE config ADD COLUMN nicehash_deep_liquidity_eh REAL NOT NULL DEFAULT 1;
