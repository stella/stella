WITH RECURSIVE prepared AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(
        btrim(
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
          '-'
        ),
        ''
      ),
      'unknown'
    ) AS "preferred_slug",
    "slug" IS NOT NULL AND btrim("slug") <> '' AS "has_existing_slug",
    "created_at"
  FROM "case_law_decisions"
),
ranked AS (
  SELECT
    "id",
    "preferred_slug",
    "has_existing_slug",
    "created_at",
    row_number() OVER (
      PARTITION BY "preferred_slug"
      ORDER BY "has_existing_slug" DESC, "created_at" ASC, "id" ASC
    ) AS "preferred_rank"
  FROM prepared
),
reserved AS (
  SELECT
    "id",
    "preferred_slug" AS "final_slug"
  FROM ranked
  WHERE "preferred_rank" = 1
),
remaining AS (
  SELECT
    "id",
    "preferred_slug",
    row_number() OVER (
      ORDER BY "has_existing_slug" DESC, "preferred_slug" ASC, "created_at" ASC, "id" ASC
    ) AS "allocation_order"
  FROM ranked
  WHERE "preferred_rank" > 1
),
allocated AS (
  SELECT
    0::bigint AS "allocation_order",
    NULL::uuid AS "id",
    NULL::text AS "final_slug",
    ARRAY(
      SELECT "final_slug"::text
      FROM reserved
      ORDER BY "final_slug"
    )::text[] AS "used_slugs"

  UNION ALL

  SELECT
    remaining."allocation_order",
    remaining."id",
    candidate."final_slug",
    array_append(allocated."used_slugs", candidate."final_slug")
  FROM allocated
  JOIN remaining
    ON remaining."allocation_order" = allocated."allocation_order" + 1
  CROSS JOIN LATERAL (
    SELECT candidate_slug."final_slug"
    FROM generate_series(2, (SELECT count(*)::integer + 1 FROM ranked)) AS suffix("value")
    CROSS JOIN LATERAL (
      SELECT (
        COALESCE(
          NULLIF(
            btrim(
              left(
                remaining."preferred_slug",
                256 - length('-' || suffix."value"::text)
              ),
              '-'
            ),
            ''
          ),
          'unknown'
        ) || '-' || suffix."value"::text
      ) AS "final_slug"
    ) AS candidate_slug
    WHERE NOT candidate_slug."final_slug" = ANY(allocated."used_slugs")
    ORDER BY suffix."value" ASC
    LIMIT 1
  ) AS candidate
),
final_slugs AS (
  SELECT
    "id",
    "final_slug"
  FROM reserved

  UNION ALL

  SELECT
    "id",
    "final_slug"
  FROM allocated
  WHERE "id" IS NOT NULL
)
UPDATE "case_law_decisions" AS decision
SET "slug" = final_slugs."final_slug"
FROM final_slugs
WHERE decision."id" = final_slugs."id"
  AND decision."slug" IS DISTINCT FROM final_slugs."final_slug";--> statement-breakpoint

CREATE UNIQUE INDEX "case_law_decisions_slug_uidx"
  ON "case_law_decisions" ("slug")
  WHERE "slug" IS NOT NULL;--> statement-breakpoint
