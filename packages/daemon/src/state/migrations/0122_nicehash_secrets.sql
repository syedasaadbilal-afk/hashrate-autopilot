-- #dual-provider: NiceHash API credentials as encrypted DB secrets.
-- Mirrors the Braiins-token pattern so the keys are entered on the in-app
-- Security page and stored encrypted in state.db - never in the wrapper env
-- or GitHub. All nullable: Braiins-only installs keep working untouched.
--
-- Forward-only and crash-safe: the migration runner tolerates a re-applied
-- "duplicate column" error, so a partial apply followed by a retry is fine.
ALTER TABLE secrets ADD COLUMN nicehash_org_id TEXT;
ALTER TABLE secrets ADD COLUMN nicehash_api_key TEXT;
ALTER TABLE secrets ADD COLUMN nicehash_api_secret TEXT;
