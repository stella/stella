-- requires: 20261022233000_mcp_web_handoff
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Release the additive migration's locks before building on existing sessions.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

-- The online migration owner checks definition, readiness and validity on boot.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_originConsentId_idx" ON "session" ("origin_consent_id");
--> statement-breakpoint

SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
-- Existing sessions have no origin; new writes already satisfy the reference.
ALTER TABLE "session" VALIDATE CONSTRAINT "session_origin_consent_id_oauth_consent_id_fk";
