-- requires: 20261003122700_matter_correspondence_view
-- One correspondence view per matter, enforced by the database. views.create
-- checks for an existing one under FOR UPDATE, but row locks cannot see a
-- view another transaction is inserting, so two concurrent creates could
-- both pass the check. The backfill this requires inserts at most one per
-- matter, so existing rows already satisfy the index.
--
-- Overview is left out on purpose: nothing has guaranteed its uniqueness in
-- stored data, and a duplicate would fail this build.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Build without blocking view writes while a deployment is upgraded.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- IF NOT EXISTS keeps a retry idempotent, and the REINDEX repairs the INVALID
-- index a cancelled concurrent build leaves behind. The online migration
-- phase validates it on every boot (src/db/online-migrations.ts).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workspace_views_correspondence_uidx"
  ON "workspace_views" ("workspace_id")
  WHERE ("layout" ->> 'type') = 'correspondence';--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "workspace_views_correspondence_uidx";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
