SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Seed the concrete pre-q09 serving generations for the first DB-authoritative
-- reader release. Never displace an existing serving row: replaying this
-- migration against a newer environment must not roll it back.
INSERT INTO "corpus_index_generations" (
  "family", "generation", "cluster", "manifest_digest", "status"
) VALUES
  (
    'case_law',
    'case_law_v2',
    'q08',
    '58871c9e83109374ed1081f73e240472d79c2d60d2e58f5e1c5f19026975b564',
    'building'
  ),
  (
    'legislation',
    'legislation_v1',
    'q08',
    '8d88e2788a736d27d1220eb9913582df62f5c87e564e1f3d91b7a4aec67b1f9c',
    'building'
  )
ON CONFLICT ON CONSTRAINT "corpus_index_generations_pkey"
DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "corpus_index_generations"
     WHERE ("family", "generation") IN (
       ('case_law', 'case_law_v2'),
       ('legislation', 'legislation_v1')
     )
       AND "cluster" <> 'q08'
  ) THEN
    RAISE EXCEPTION 'legacy corpus generation has an invalid cluster binding';
  END IF;
END;
$$;--> statement-breakpoint

UPDATE "corpus_index_generations" target
   SET "status" = 'serving',
       "updated_at" = clock_timestamp()
 WHERE (target."family", target."generation") IN (
   ('case_law', 'case_law_v2'),
   ('legislation', 'legislation_v1')
 )
   AND target."status" IN ('building', 'retiring')
   AND NOT EXISTS (
     SELECT 1
       FROM "corpus_index_generations" serving
      WHERE serving."family" = target."family"
        AND serving."status" = 'serving'
   );--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT family
      FROM (VALUES ('case_law'), ('legislation')) required(family)
     WHERE NOT EXISTS (
       SELECT 1
         FROM "corpus_index_generations" serving
        WHERE serving."family" = required.family
          AND serving."status" = 'serving'
     )
  ) THEN
    RAISE EXCEPTION 'corpus family has no serving generation';
  END IF;
END;
$$;
