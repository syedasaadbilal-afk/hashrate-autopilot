-- #52: tag each bid_events row with the provider it belongs to so the
-- Timeline can reflect NiceHash order/price changes alongside Braiins.
-- Historically bid_events was Braiins-only, so existing rows are BRAIINS.
--
-- Additive + NOT NULL DEFAULT, so existing rows read the default and the
-- Braiins insert path (which omits provider) keeps working unchanged. Safe
-- to re-apply (the migration runner tolerates a duplicate-column error).
ALTER TABLE bid_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'BRAIINS';
