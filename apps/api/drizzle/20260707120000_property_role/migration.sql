SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "role" text;--> statement-breakpoint
UPDATE "properties" AS p
SET "role" = 'document-type-classifier'
FROM (
	SELECT id,
		row_number() OVER (
			PARTITION BY workspace_id
			ORDER BY created_at ASC, id ASC
		) AS rn
	FROM "properties"
	WHERE lower(trim("name")) = 'document type'
		AND "content"->>'type' = 'single-select'
		AND "tool"->>'type' = 'ai-model'
) AS c
WHERE p.id = c.id AND c.rn = 1;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "properties_ws_document_type_classifier_unq" ON "properties" USING btree ("workspace_id") WHERE "role" = 'document-type-classifier';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
