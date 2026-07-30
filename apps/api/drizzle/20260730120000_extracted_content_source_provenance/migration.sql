-- Additive provenance lets recovery distinguish current immutable sources
-- from stale extraction rows written for an older version or fingerprint.
-- Legacy rows stay nullable until a bounded backfill can prove their source.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Every statement before the explicit COMMIT must tolerate replay after a
-- later concurrent index build is interrupted.
ALTER TABLE "extracted_content" ADD COLUMN IF NOT EXISTS "source_entity_version_id" uuid;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN IF NOT EXISTS "source_field_id" uuid;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN IF NOT EXISTS "source_file_id" uuid;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN IF NOT EXISTS "source_sha256_hex" varchar(64);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'extracted_content_source_entity_version_id_entity_versions_id_f'
      AND conrelid = 'extracted_content'::regclass
  ) THEN
    ALTER TABLE "extracted_content"
      ADD CONSTRAINT "extracted_content_source_entity_version_id_entity_versions_id_f"
      FOREIGN KEY ("source_entity_version_id") REFERENCES "entity_versions"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END
$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'extracted_content_source_field_id_fields_id_fk'
      AND conrelid = 'extracted_content'::regclass
  ) THEN
    ALTER TABLE "extracted_content"
      ADD CONSTRAINT "extracted_content_source_field_id_fields_id_fk"
      FOREIGN KEY ("source_field_id") REFERENCES "fields"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END
$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'extracted_content_source_sha256_hex_check'
      AND conrelid = 'extracted_content'::regclass
  ) THEN
    ALTER TABLE "extracted_content"
      ADD CONSTRAINT "extracted_content_source_sha256_hex_check"
      CHECK ("source_sha256_hex" IS NULL OR "source_sha256_hex" ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint

-- The source foreign keys use ON DELETE SET NULL. Build their referencing
-- indexes without blocking writes before those delete paths become active.
-- Drizzle wraps migrations in a transaction, while concurrent builds must run
-- outside one; restore the standard short timeouts before reopening it.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- A failed concurrent build can leave an INVALID index. Drop only this
-- migration's indexes so replay always starts from a known state.
-- stella-migration-safety: reviewed destructive-change - retry cleanup only.
DROP INDEX CONCURRENTLY IF EXISTS "extracted_content_source_entity_version_id_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only.
DROP INDEX CONCURRENTLY IF EXISTS "extracted_content_source_field_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "extracted_content_source_entity_version_id_idx"
  ON "extracted_content" ("source_entity_version_id");
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "extracted_content_source_field_id_idx"
  ON "extracted_content" ("source_field_id");
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
