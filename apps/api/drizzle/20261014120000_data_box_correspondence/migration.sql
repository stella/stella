SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A data-box message records its envelope; email rows keep it null, so the
-- previous release's inserts stay valid during the rollout.
ALTER TABLE "correspondence" ADD COLUMN IF NOT EXISTS "data_box_envelope" jsonb;--> statement-breakpoint

-- Build the index without holding the DDL transaction's locks through the
-- scan.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- Serves matching a data-box message's box IDs to contacts. IF NOT EXISTS
-- keeps a retry idempotent, and the REINDEX repairs the INVALID index a
-- cancelled concurrent build leaves behind. The online migration phase
-- validates it on every boot (src/db/online-migrations.ts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_data_box_ids_idx" ON "contacts" USING gin (("metadata" -> 'dataBoxes') jsonb_path_ops);
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "contacts_data_box_ids_idx";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
-- The constraints are added NOT VALID; 20261014120100 validates them outside
-- this transaction.
-- stella-migration-safety: reviewed drop-constraint - replaced in this transaction by a check that admits every existing email row and adds the data-box channel
ALTER TABLE "correspondence" DROP CONSTRAINT "correspondence_channel_check";--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_channel_check" CHECK ("channel" in ('email', 'data_box')) NOT VALID;--> statement-breakpoint
-- Exactly the data-box rows carry an envelope; one is always read from an
-- uploaded file and keeps its message ID.
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_data_box_check" CHECK ((("channel" = 'data_box') = ("data_box_envelope" is not null) and ("channel" <> 'data_box' or ("source" = 'upload' and "message_id" is not null and jsonb_typeof("data_box_envelope") = 'object' and "data_box_envelope"->>'messageId' = "message_id"))) is true) NOT VALID;
