-- #C/#F (v1.18.14): "hash paid for but not delivered" alert. Fires when the
-- share of purchased hashrate that Ocean does NOT credit stays above
-- hash_loss_variance_alert_pct for hash_loss_alert_after_minutes.
--
-- Sustained-window gated because Ocean's hashrate is a 5-min trailing average
-- and delivery swings minute to minute - a short spike is measurement lag, not
-- a leak. Defaults: 15% over 30 minutes (above the few-percent baseline loss
-- that routing/stale shares cause in normal operation).
ALTER TABLE config ADD COLUMN hash_loss_variance_alert_pct REAL NOT NULL DEFAULT 15;
ALTER TABLE config ADD COLUMN hash_loss_alert_after_minutes INTEGER NOT NULL DEFAULT 30;
