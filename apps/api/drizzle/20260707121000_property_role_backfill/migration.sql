SET lock_timeout = '1s';--> statement-breakpoint
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
DO $$
DECLARE
	batch_size integer := 500;
	updated_count integer;
BEGIN
	LOOP
		WITH next_batch AS (
			SELECT p.id
			FROM "properties" AS p
			INNER JOIN "_property_role_backfill_candidates" AS c ON c.id = p.id
			WHERE p."role" IS DISTINCT FROM 'document-type-classifier'
			LIMIT batch_size
			FOR UPDATE OF p SKIP LOCKED
		)
		UPDATE "properties" AS p
		SET "role" = 'document-type-classifier'
		FROM next_batch
		WHERE p.id = next_batch.id;

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
	END LOOP;
END $$;--> statement-breakpoint
