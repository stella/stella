WITH prepared AS (
  SELECT
    "id",
    COALESCE(
      left(
        NULLIF(
          btrim(
            regexp_replace(
              lower(unaccent(COALESCE(NULLIF(btrim("slug"), ''), "case_number"))),
              '[^a-z0-9]+',
              '-',
              'g'
            ),
            '-'
          ),
          ''
        ),
        256
      ),
      'unknown'
    ) AS "preferred_slug",
    "slug" IS NOT NULL AND btrim("slug") <> '' AS "has_existing_slug",
    "created_at"
  FROM "case_law_decisions"
),
numbered AS (
  SELECT
    "id",
    "preferred_slug",
    row_number() OVER (
      PARTITION BY "preferred_slug"
      ORDER BY "has_existing_slug" DESC, "created_at" ASC, "id" ASC
    ) AS "slug_suffix"
  FROM prepared
)
UPDATE "case_law_decisions" AS decision
SET "slug" = CASE
  WHEN numbered."slug_suffix" = 1 THEN left(numbered."preferred_slug", 256)
  ELSE left(
    numbered."preferred_slug",
    256 - length('-' || numbered."slug_suffix"::text)
  ) || '-' || numbered."slug_suffix"::text
END
FROM numbered
WHERE decision."id" = numbered."id"
  AND decision."slug" IS DISTINCT FROM CASE
    WHEN numbered."slug_suffix" = 1 THEN left(numbered."preferred_slug", 256)
    ELSE left(
      numbered."preferred_slug",
      256 - length('-' || numbered."slug_suffix"::text)
    ) || '-' || numbered."slug_suffix"::text
  END;--> statement-breakpoint

CREATE UNIQUE INDEX "case_law_decisions_slug_uidx"
  ON "case_law_decisions" ("slug")
  WHERE "slug" IS NOT NULL;--> statement-breakpoint
