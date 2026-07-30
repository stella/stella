-- Additive provenance lets recovery distinguish current immutable sources
-- from stale extraction rows written for an older version or fingerprint.
-- Legacy rows stay nullable until a bounded backfill can prove their source.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN "source_entity_version_id" uuid;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN "source_field_id" uuid;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN "source_file_id" uuid;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN "source_sha256_hex" varchar(64);--> statement-breakpoint
ALTER TABLE "extracted_content" ADD CONSTRAINT "extracted_content_source_entity_version_id_entity_versions_id_fk"
  FOREIGN KEY ("source_entity_version_id") REFERENCES "entity_versions"("id") ON DELETE SET NULL NOT VALID;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD CONSTRAINT "extracted_content_source_field_id_fields_id_fk"
  FOREIGN KEY ("source_field_id") REFERENCES "fields"("id") ON DELETE SET NULL NOT VALID;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD CONSTRAINT "extracted_content_source_sha256_hex_check"
  CHECK ("source_sha256_hex" IS NULL OR "source_sha256_hex" ~ '^[0-9a-f]{64}$') NOT VALID;
