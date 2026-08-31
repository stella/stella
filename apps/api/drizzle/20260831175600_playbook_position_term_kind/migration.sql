SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint

-- A reference-standard position now says what SHAPE of term it is about, and
-- grading may only answer it with that shape. `language` is what a position
-- written before the distinction existed can honestly claim: it was proposed
-- clause-level, so nothing structural about it is known.
--
-- The column shape does not change; only the positions stored inside it do.
-- Each statement is guarded on the key's absence, so a replay lifts nothing a
-- second time.

UPDATE "playbook_definitions"
   SET "positions" = jsonb_set(
         "positions",
         '{items}',
         COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN item->'standard'->>'source' = 'reference'
                          AND NOT (item->'standard' ? 'termKind')
                      THEN jsonb_set(item, '{standard,termKind}', '"language"'::jsonb)
                      ELSE item
                    END
                    ORDER BY ord
                  )
             FROM jsonb_array_elements("positions"->'items')
                  WITH ORDINALITY AS entry(item, ord)
         ), '[]'::jsonb)
       )
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_array_elements("positions"->'items') AS entry(item)
          WHERE item->'standard'->>'source' = 'reference'
            AND NOT (item->'standard' ? 'termKind')
       );--> statement-breakpoint

UPDATE "playbook_definition_versions"
   SET "positions" = jsonb_set(
         "positions",
         '{items}',
         COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN item->'standard'->>'source' = 'reference'
                          AND NOT (item->'standard' ? 'termKind')
                      THEN jsonb_set(item, '{standard,termKind}', '"language"'::jsonb)
                      ELSE item
                    END
                    ORDER BY ord
                  )
             FROM jsonb_array_elements("positions"->'items')
                  WITH ORDINALITY AS entry(item, ord)
         ), '[]'::jsonb)
       )
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_array_elements("positions"->'items') AS entry(item)
          WHERE item->'standard'->>'source' = 'reference'
            AND NOT (item->'standard' ? 'termKind')
       );--> statement-breakpoint

-- A run pins its playbook by value, so the same lift applies inside the
-- snapshot: a queued run must plan from a basis the current schema accepts.
UPDATE "document_review_runs"
   SET "basis" = jsonb_set(
         "basis",
         '{playbook,definitionSnapshot,positions,items}',
         COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN item->'standard'->>'source' = 'reference'
                          AND NOT (item->'standard' ? 'termKind')
                      THEN jsonb_set(item, '{standard,termKind}', '"language"'::jsonb)
                      ELSE item
                    END
                    ORDER BY ord
                  )
             FROM jsonb_array_elements(
                    "basis"->'playbook'->'definitionSnapshot'->'positions'->'items'
                  ) WITH ORDINALITY AS entry(item, ord)
         ), '[]'::jsonb)
       )
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
                  "basis"->'playbook'->'definitionSnapshot'->'positions'->'items'
                ) AS entry(item)
          WHERE item->'standard'->>'source' = 'reference'
            AND NOT (item->'standard' ? 'termKind')
       );
