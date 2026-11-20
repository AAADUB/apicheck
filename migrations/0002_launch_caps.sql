-- Launch limits counted on the launch rows themselves, so a deleted or edited watch can never free a place:
--   grp: the shared group the launch counted against; state gains 'ended' (the provider confirmed the machine is gone).
ALTER TABLE launches ADD COLUMN grp TEXT;
CREATE INDEX IF NOT EXISTS launches_by_provider ON launches (user_id, provider, state);
CREATE INDEX IF NOT EXISTS launches_by_group ON launches (user_id, grp, state);
