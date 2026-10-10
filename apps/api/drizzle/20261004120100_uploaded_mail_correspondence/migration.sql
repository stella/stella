SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Existing rows are deliveries. The default also keeps inserts from tasks
-- still running the previous release valid during the rollout.
ALTER TABLE "correspondence"
  ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'delivery' NOT NULL,
  ADD COLUMN IF NOT EXISTS "source_entity_id" uuid;--> statement-breakpoint
-- The previous release writes every one of these columns on each delivery,
-- and the provenance check below keeps them required for delivery rows.
-- squawk-ignore ban-drop-not-null -- delivery writers still set it; the provenance check keeps it required for deliveries
ALTER TABLE "correspondence" ALTER COLUMN "intake" DROP NOT NULL;--> statement-breakpoint
-- squawk-ignore ban-drop-not-null -- delivery writers still set it; the provenance check keeps it required for deliveries
ALTER TABLE "correspondence" ALTER COLUMN "authenticated_sender_address" DROP NOT NULL;--> statement-breakpoint
-- squawk-ignore ban-drop-not-null -- delivery writers still set it; the provenance check keeps it required for deliveries
ALTER TABLE "correspondence" ALTER COLUMN "spf" DROP NOT NULL;--> statement-breakpoint
-- squawk-ignore ban-drop-not-null -- delivery writers still set it; the provenance check keeps it required for deliveries
ALTER TABLE "correspondence" ALTER COLUMN "dkim" DROP NOT NULL;--> statement-breakpoint
-- squawk-ignore ban-drop-not-null -- delivery writers still set it; the provenance check keeps it required for deliveries
ALTER TABLE "correspondence" ALTER COLUMN "dmarc" DROP NOT NULL;--> statement-breakpoint

-- Build the indexes without holding the DDL transaction's locks through the
-- scans.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- One email file yields at most one record. IF NOT EXISTS keeps a retry
-- idempotent, and the REINDEX repairs the INVALID index a cancelled concurrent
-- build leaves behind. The online migration phase validates it on every boot
-- (src/db/online-migrations.ts).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "correspondence_ws_source_entity_uidx" ON "correspondence" ("workspace_id", "source_entity_id");
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "correspondence_ws_source_entity_uidx";
--> statement-breakpoint
-- Serves the attachment lookup by file and the cascade from a deleted file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "correspondence_attachments_ws_entity_idx" ON "correspondence_attachments" ("workspace_id", "entity_id");
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "correspondence_attachments_ws_entity_idx";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
-- The constraints are added NOT VALID; 20261004120200 validates them outside
-- this transaction.
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_source_check" CHECK ("source" in ('delivery', 'upload')) NOT VALID;--> statement-breakpoint
-- Delivery rows keep every transport-authentication column the dropped NOT
-- NULL constraints required; upload rows carry none of them.
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_provenance_check" CHECK ((("source" = 'delivery' and "intake" is not null and "authenticated_sender_address" is not null and "spf" is not null and "dkim" is not null and "dmarc" is not null and "source_entity_id" is null) or ("source" = 'upload' and "intake" is null and "authenticated_sender_address" is null and "spf" is null and "dkim" is null and "dmarc" is null and "aligned_identifier" is null and "source_entity_id" is not null)) is true) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - replaced in this transaction by a check that admits the same delivery rows and adds the upload branch
ALTER TABLE "correspondence" DROP CONSTRAINT "correspondence_original_signature_check";--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_original_signature_check" CHECK ((("intake" = 'direct' and "original_signature" is null) or ("intake" in ('forwarded_inline', 'forwarded_attachment') and "original_signature" = '{"status":"unverified"}'::jsonb) or ("source" = 'upload' and "original_signature" = '{"status":"unverified"}'::jsonb) or (("intake" = 'forwarded_attachment' or "source" = 'upload') and "original_signature"->>'status' = 'verified' and jsonb_typeof("original_signature"->'domain') = 'string' and length("original_signature"->>'domain') > 0)) is true) NOT VALID;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_source_entity_workspace_fk" FOREIGN KEY ("source_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE cascade NOT VALID;
