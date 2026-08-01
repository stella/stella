SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Additive and nullable for existing report-export receipts. A field can be
-- deleted with its source version, so preserve the receipt and clear only the
-- direct-link hint.
ALTER TABLE "report_exports"
  ADD COLUMN IF NOT EXISTS "result_field_id" uuid;
--> statement-breakpoint
-- Existing workspace exports already retain the created entity. Resolve its
-- current file once so dropping the redirect route does not strand old rows.
UPDATE "report_exports" AS "report_export"
SET "result_field_id" = (
  SELECT "field"."id"
  FROM "entities" AS "entity"
  INNER JOIN "fields" AS "field"
    ON "field"."entity_version_id" = "entity"."current_version_id"
   AND "field"."workspace_id" = "report_export"."workspace_id"
  WHERE "entity"."id" = "report_export"."result_entity_id"
    AND "entity"."workspace_id" = "report_export"."workspace_id"
    AND "field"."content"->>'type' = 'file'
  ORDER BY "field"."id"
  LIMIT 1
)
WHERE "report_export"."result_entity_id" IS NOT NULL
  AND "report_export"."result_field_id" IS NULL;
--> statement-breakpoint
-- Drizzle wraps migrations in a transaction, but this referencing-side index
-- must not block writes while the report history grows. A cancelled concurrent
-- build leaves an INVALID index, so retry by dropping this migration's index
-- before recreating it rather than relying on IF NOT EXISTS.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = '0';
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's index if a cancelled concurrent build left it invalid; no table
-- or column data is removed.
DROP INDEX CONCURRENTLY IF EXISTS "report_exports_result_field_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "report_exports_result_field_idx"
  ON "report_exports" ("result_field_id");
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_exports_result_field_fk'
  ) THEN
    ALTER TABLE "report_exports"
      ADD CONSTRAINT "report_exports_result_field_fk"
      FOREIGN KEY ("result_field_id") REFERENCES "fields"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
