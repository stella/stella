-- requires: 20261009190430_chat_message_revisions
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "chat_content_v3_backfill_receipts" (
  "source" text NOT NULL,
  "row_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "from_version" integer,
  "outcome" text NOT NULL,
  "reason" text NOT NULL,
  "recorded_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chat_content_v3_backfill_receipts_pkey" PRIMARY KEY ("source", "row_id"),
  CONSTRAINT "chat_content_v3_receipts_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization" ("id") ON DELETE CASCADE,
  CONSTRAINT "chat_content_v3_backfill_receipts_source_check" CHECK ("source" IN ('message', 'revision')),
  CONSTRAINT "chat_content_v3_backfill_receipts_outcome_check" CHECK ("outcome" IN ('converted', 'skipped', 'failed', 'deleted-concurrently'))
);--> statement-breakpoint

CREATE INDEX "chat_content_v3_receipts_org_idx" ON "chat_content_v3_backfill_receipts" ("organization_id");--> statement-breakpoint

-- Owner-only: the backfill and deploy repair run as the table owner; request roles get nothing.
ALTER TABLE "chat_content_v3_backfill_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_content_v3_backfill_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "chat_content_v3_backfill_receipts_owner_access" ON "chat_content_v3_backfill_receipts" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_content_v3_backfill_receipts'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_content_v3_backfill_receipts'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "chat_content_v3_backfill_receipts" FROM stella;--> statement-breakpoint

CREATE INDEX "chat_content_v3_backfill_receipts_message_idx"
  ON "chat_content_v3_backfill_receipts" ("message_id");--> statement-breakpoint

-- Enforce the cutover for new writes while existing rows are repaired online.
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_content_v3_check"
  CHECK (("content" -> 'version') IS NOT DISTINCT FROM '3'::jsonb) NOT VALID;--> statement-breakpoint

ALTER TABLE "chat_message_revisions" ADD CONSTRAINT "chat_message_revisions_content_v3_check"
  CHECK (("content" -> 'version') IS NOT DISTINCT FROM '3'::jsonb) NOT VALID;
