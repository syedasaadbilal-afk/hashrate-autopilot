-- B6: slab-based sizing across BOTH providers, replacing the Braiins-only
-- cheap mode. JSON array of { maxPct, targetPh }, matched in ascending
-- maxPct against the ACTIVE venue's fee-inclusive price as a % of
-- hashprice. targetPh 0 (or a price above every slab) = PARK / buy nothing.
-- Empty string = use the built-in default table (the operator's own).
--
-- cheap_mode_slabs_enabled gates it so the legacy cheap-mode path stays
-- intact for anyone who prefers it; 1 = slabs drive sizing.
ALTER TABLE config ADD COLUMN cheap_mode_slabs TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN cheap_mode_slabs_enabled INTEGER NOT NULL DEFAULT 0;
