/**
 * Reduce stored reference passages to the ids the current schema stores.
 *
 * Findings, playbook positions, playbook versions and run snapshots written
 * before passages were addressed by id carry a copy of each passage's words;
 * the words live in `document_review_reference_passages` and resolve by id.
 * Each step rewrites a bounded batch of rows that still carry words and
 * reports how many it changed, so a caller repeats a step until it reports
 * zero. Every predicate is the presence of words, so the steps are
 * idempotent and can be run again at any time (`scripts/
 * normalize-review-passage-references.ts`).
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/** `pg_temp` helpers the position steps use; created per transaction, the
 *  first before the second. */
export const PASSAGES_BY_ID_FUNCTION =
  sql.raw(`CREATE OR REPLACE FUNCTION pg_temp.passages_by_id(passages jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(passage - 'text' ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements(passages) WITH ORDINALITY AS entry(passage, ord)
$$`);

export const POSITION_ITEMS_BY_ID_FUNCTION =
  sql.raw(`CREATE OR REPLACE FUNCTION pg_temp.position_items_by_id(items jsonb) RETURNS jsonb
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
$$`);

type PassageReferenceStep = {
  name: string;
  /** Rows that still carry words. */
  pending: SQL;
  /** Rewrites up to `limit` of them; answers `{ changed }`. */
  rewrite: (limit: number) => SQL;
};

const batch = (table: string, pending: string, set: string, limit: number) =>
  sql.raw(`WITH changed AS (
  UPDATE "${table}"
     SET ${set}
   WHERE "id" IN (
     SELECT "id" FROM "${table}" WHERE ${pending} ORDER BY "id" LIMIT ${String(limit)}
   )
  RETURNING 1
)
SELECT count(*)::int AS changed FROM changed`);

const step = (
  name: string,
  table: string,
  pending: string,
  set: string,
): PassageReferenceStep => ({
  name,
  pending: sql.raw(
    `SELECT count(*)::int AS pending FROM "${table}" WHERE ${pending}`,
  ),
  rewrite: (limit) => batch(table, pending, set, limit),
});

const POSITION_ITEMS_WITH_WORDS = (column: string, path: string) =>
  `jsonb_path_exists("${column}", '${path}.items[*].standard.passages[*] ? (exists(@.text))')`;

export const PASSAGE_REFERENCE_STEPS: readonly PassageReferenceStep[] = [
  step(
    "finding standard citations",
    "document_review_findings",
    `"payload" #>> '{finding,standardSource}' = 'reference'
       AND "payload" #>> '{finding,delta,kind}' = 'parameter'
       AND jsonb_typeof("payload" #> '{finding,delta,standard,citation}') = 'object'
       AND COALESCE("payload" #>> '{finding,delta,standard,citation,text}', '') <> ''`,
    `"payload" = jsonb_set("payload", '{finding,delta,standard,citation,text}', '""'::jsonb)`,
  ),
  step(
    "finding reference citations",
    "document_review_findings",
    `jsonb_typeof("payload" #> '{finding,referenceCitations}') = 'array'
       AND jsonb_path_exists("payload", '$.finding.referenceCitations[*].passages[*] ? (exists(@.text))')`,
    `"payload" = jsonb_set(
       "payload",
       '{finding,referenceCitations}',
       COALESCE((
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'fileFieldId', citation->'fileFieldId',
                    'passages', (
                      SELECT COALESCE(jsonb_agg(
                               jsonb_build_object('id', passage->'id', 'blockId', passage->'blockId')
                               ORDER BY pord
                             ), '[]'::jsonb)
                        FROM jsonb_array_elements(citation->'passages') WITH ORDINALITY AS p(passage, pord)
                    )
                  )
                  ORDER BY ord
                )
           FROM jsonb_array_elements("payload" #> '{finding,referenceCitations}') WITH ORDINALITY AS entry(citation, ord)
       ), '[]'::jsonb)
     )`,
  ),
  step(
    "playbook positions",
    "playbook_definitions",
    POSITION_ITEMS_WITH_WORDS("positions", "$"),
    `"positions" = jsonb_set("positions", '{items}', pg_temp.position_items_by_id("positions"->'items'))`,
  ),
  step(
    "playbook version positions",
    "playbook_definition_versions",
    POSITION_ITEMS_WITH_WORDS("positions", "$"),
    `"positions" = jsonb_set("positions", '{items}', pg_temp.position_items_by_id("positions"->'items'))`,
  ),
  step(
    "run snapshot positions",
    "document_review_runs",
    POSITION_ITEMS_WITH_WORDS(
      "basis",
      "$.playbook.definitionSnapshot.positions",
    ),
    `"basis" = jsonb_set(
       "basis",
       '{playbook,definitionSnapshot,positions,items}',
       pg_temp.position_items_by_id("basis"->'playbook'->'definitionSnapshot'->'positions'->'items')
     )`,
  ),
];
