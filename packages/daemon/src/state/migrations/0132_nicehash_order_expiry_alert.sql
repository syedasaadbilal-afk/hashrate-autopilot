-- B1: lead time (days) before a NiceHash order's best-effort-parsed expiry
-- for the Next Action card to start showing a loud countdown warning. 0
-- disables the check. Default 3 days - the operator's own reported lead
-- time was "expires in ~10 days," so 3 gives a comfortable manual-renewal
-- window (see V14-ISSUES-LOG.md B1: creation can require manual action, so
-- this must not lapse silently).
ALTER TABLE config ADD COLUMN nicehash_order_expiry_alert_days INTEGER NOT NULL DEFAULT 3;
