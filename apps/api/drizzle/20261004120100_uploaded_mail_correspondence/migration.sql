SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Existing rows are deliveries. The default also keeps inserts from tasks
-- still running the previous release valid during the rollout.
ALTER TABLE "correspondence" ADD COLUMN "source" text DEFAULT 'delivery' NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondence" ADD COLUMN "source_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "correspondence" ALTER COLUMN "intake" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondence" ALTER COLUMN "authenticated_sender_address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondence" ALTER COLUMN "spf" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondence" ALTER COLUMN "dkim" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondence" ALTER COLUMN "dmarc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_source_check" CHECK ("source" in ('delivery', 'upload'));--> statement-breakpoint
-- Delivery rows keep every transport-authentication column the dropped NOT
-- NULL constraints required; upload rows carry none of them.
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_provenance_check" CHECK ((("source" = 'delivery' and "intake" is not null and "authenticated_sender_address" is not null and "spf" is not null and "dkim" is not null and "dmarc" is not null and "source_entity_id" is null) or ("source" = 'upload' and "intake" is null and "authenticated_sender_address" is null and "spf" is null and "dkim" is null and "dmarc" is null and "aligned_identifier" is null and "source_entity_id" is not null)) is true);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - replaced in this transaction by a check that admits the same delivery rows and adds the upload branch
ALTER TABLE "correspondence" DROP CONSTRAINT "correspondence_original_signature_check";--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_original_signature_check" CHECK ((("intake" = 'direct' and "original_signature" is null) or ("intake" in ('forwarded_inline', 'forwarded_attachment') and "original_signature" = '{"status":"unverified"}'::jsonb) or ("source" = 'upload' and "original_signature" = '{"status":"unverified"}'::jsonb) or (("intake" = 'forwarded_attachment' or "source" = 'upload') and "original_signature"->>'status' = 'verified' and jsonb_typeof("original_signature"->'domain') = 'string' and length("original_signature"->>'domain') > 0)) is true);--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_source_entity_workspace_fk" FOREIGN KEY ("source_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE cascade;--> statement-breakpoint
-- One email file yields at most one record.
CREATE UNIQUE INDEX "correspondence_ws_source_entity_uidx" ON "correspondence" ("workspace_id", "source_entity_id");--> statement-breakpoint
-- Serves the attachment lookup by file and the cascade from a deleted file.
CREATE INDEX "correspondence_attachments_ws_entity_idx" ON "correspondence_attachments" ("workspace_id", "entity_id");
