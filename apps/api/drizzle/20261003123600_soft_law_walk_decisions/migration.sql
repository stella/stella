-- requires: 20261003123500_soft_law_corpus
SET lock_timeout = '1s';
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE soft_law_ingestion_attempts ADD COLUMN observation jsonb;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaced below with the existing states plus the durable deferred state.
ALTER TABLE soft_law_ingestion_attempts DROP CONSTRAINT soft_law_attempts_status_check;
--> statement-breakpoint
ALTER TABLE soft_law_ingestion_attempts ADD CONSTRAINT soft_law_attempts_status_check CHECK (status IN ('applied','unchanged','rejected','retryable','deferred'));
--> statement-breakpoint
ALTER TABLE soft_law_ingestion_attempts ADD CONSTRAINT soft_law_attempts_deferred_check CHECK ((status <> 'deferred' OR observation IS NOT NULL) AND (observation IS NULL OR jsonb_typeof(observation) = 'object'));
--> statement-breakpoint
CREATE INDEX soft_law_attempts_deferred_idx ON soft_law_ingestion_attempts(source_id,run_id,url) WHERE status = 'deferred';
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retires the obsolete collision-receipt lookup index; no receipt rows are removed.
DROP INDEX soft_law_attempts_collision_idx;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaced below with the existing states plus the leased deciding state.
ALTER TABLE soft_law_sources DROP CONSTRAINT soft_law_sources_state_check;
--> statement-breakpoint
ALTER TABLE soft_law_sources ADD CONSTRAINT soft_law_sources_state_check CHECK (run_state IN ('idle','running','deciding','blocked','failed','listing_incomplete'));
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaced below to permit leases during both fetching and durable decisions.
ALTER TABLE soft_law_sources DROP CONSTRAINT soft_law_sources_lease_check;
--> statement-breakpoint
ALTER TABLE soft_law_sources ADD CONSTRAINT soft_law_sources_lease_check CHECK ((lease_token IS NULL AND lease_expires_at IS NULL) OR (run_state IN ('running','deciding') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL));
