SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint

-- Reference passages are addressed by id: their words live in
-- document_review_reference_passages and resolve through the passages
-- endpoint. Stored findings, playbook positions and run snapshots written
-- before that carry a copy of the words; these statements reduce them to the
-- ids the current schema stores. Each statement is guarded on the copy's
-- presence, so a replay changes nothing.

-- Passage objects keep every key but `text`.
CREATE OR REPLACE FUNCTION pg_temp.passages_by_id(passages jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(passage - 'text' ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements(passages) WITH ORDINALITY AS entry(passage, ord)
$$;--> statement-breakpoint

-- A position list with each reference position's passages reduced to ids.
CREATE OR REPLACE FUNCTION pg_temp.position_items_by_id(items jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(
           CASE WHEN jsonb_typeof(item #> '{standard,passages}') = 'array'
             THEN jsonb_set(
                    item,
                    '{standard,passages}',
                    pg_temp.passages_by_id(item #> '{standard,passages}')
                  )
             ELSE item
           END
           ORDER BY ord
         ), '[]'::jsonb)
    FROM jsonb_array_elements(items) WITH ORDINALITY AS entry(item, ord)
$$;--> statement-breakpoint

-- stella-migration-safety: reviewed unbounded-update - rewrites only findings whose stored standard citation still carries its block text, reducing it to the block id (the term itself is kept); the passage text remains in its source document and passages table
UPDATE "document_review_findings"
   SET "payload" = jsonb_set(
         "payload",
         '{finding,delta,standard,citation,text}',
         '""'::jsonb
       )
 WHERE "payload" #>> '{finding,standardSource}' = 'reference'
   AND "payload" #>> '{finding,delta,kind}' = 'parameter'
   AND jsonb_typeof("payload" #> '{finding,delta,standard,citation}') = 'object'
   AND COALESCE("payload" #>> '{finding,delta,standard,citation,text}', '') <> '';--> statement-breakpoint

-- stella-migration-safety: reviewed unbounded-update - rewrites only findings whose reference citations still carry passage words, keeping each passage's id and block id
UPDATE "document_review_findings"
   SET "payload" = jsonb_set(
         "payload",
         '{finding,referenceCitations}',
         COALESCE((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'fileFieldId', citation->'fileFieldId',
                      'passages', (
                        SELECT COALESCE(jsonb_agg(
                                 jsonb_build_object(
                                   'id', passage->'id',
                                   'blockId', passage->'blockId'
                                 )
                                 ORDER BY pord
                               ), '[]'::jsonb)
                          FROM jsonb_array_elements(citation->'passages')
                               WITH ORDINALITY AS p(passage, pord)
                      )
                    )
                    ORDER BY ord
                  )
             FROM jsonb_array_elements("payload" #> '{finding,referenceCitations}')
                  WITH ORDINALITY AS entry(citation, ord)
         ), '[]'::jsonb)
       )
 WHERE jsonb_typeof("payload" #> '{finding,referenceCitations}') = 'array'
   AND jsonb_path_exists(
         "payload",
         '$.finding.referenceCitations[*].passages[*] ? (exists(@.text))'
       );--> statement-breakpoint

-- stella-migration-safety: reviewed unbounded-update - removes the copied words from reference passages in playbook positions that still carry them; grading reads passage words by id from the passages table
UPDATE "playbook_definitions"
   SET "positions" = jsonb_set(
         "positions",
         '{items}',
         pg_temp.position_items_by_id("positions"->'items')
       )
 WHERE jsonb_path_exists(
         "positions",
         '$.items[*].standard.passages[*] ? (exists(@.text))'
       );--> statement-breakpoint

-- stella-migration-safety: reviewed unbounded-update - the same reduction for saved playbook versions
UPDATE "playbook_definition_versions"
   SET "positions" = jsonb_set(
         "positions",
         '{items}',
         pg_temp.position_items_by_id("positions"->'items')
       )
 WHERE jsonb_path_exists(
         "positions",
         '$.items[*].standard.passages[*] ? (exists(@.text))'
       );--> statement-breakpoint

-- stella-migration-safety: reviewed unbounded-update - the same reduction inside run snapshots, which pin their playbook by value
UPDATE "document_review_runs"
   SET "basis" = jsonb_set(
         "basis",
         '{playbook,definitionSnapshot,positions,items}',
         pg_temp.position_items_by_id(
           "basis"->'playbook'->'definitionSnapshot'->'positions'->'items'
         )
       )
 WHERE jsonb_path_exists(
         "basis",
         '$.playbook.definitionSnapshot.positions.items[*].standard.passages[*] ? (exists(@.text))'
       );
