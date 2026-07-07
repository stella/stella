SET lock_timeout = 0;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
CREATE TEMP TABLE "_property_role_backfill_candidates" ON COMMIT DROP AS
SELECT id
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
) AS candidates
WHERE rn = 1;--> statement-breakpoint
UPDATE "properties" AS p
SET "role" = 'document-type-classifier'
FROM "_property_role_backfill_candidates" AS c
WHERE p.id = c.id
	AND p."role" IS DISTINCT FROM 'document-type-classifier';--> statement-breakpoint
