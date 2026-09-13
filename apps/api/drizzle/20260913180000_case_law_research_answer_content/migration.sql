SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A question column becomes a matter property asked of a decision: it carries
-- the property model's own `content` (kind, select options, fallback) instead
-- of a two-value `answer_type`, its answer is the `FieldContent` a workspace
-- field holds, and a run's cited passages are justification blocks. One cell
-- renderer and one output schema then serve both surfaces.
--
-- Data: case law is feature-gated and these tables hold no production rows, so
-- this is a cutover with a fixed mapping rather than a staged backfill.
--   * a `yes_no` column becomes a single-select over two options, because the
--     property model has no boolean kind and a select already expresses "the
--     text does not settle it" as its null value; a `text` column keeps its
--     kind.
--   * `{"type":"yes_no","value":"yes"|"no"}` becomes the matching
--     single-select value, `"unclear"` becomes null, and a non-empty
--     `{"type":"text"}` keeps its string.
--   * an answered cell whose stored answer maps to no field content is marked
--     failed with the reason it could not be kept, never silently emptied.
--   * a run's `passages` become `justification.blocks` of kind
--     `decision-passage`.

ALTER TABLE "case_law_research_columns"
  ADD COLUMN "content" jsonb NOT NULL DEFAULT '{"version":1,"type":"text"}'::jsonb;
--> statement-breakpoint

-- Bounded by the per-organization column cap (20 rows per tenant), and by the
-- answer type it rewrites.
UPDATE "case_law_research_columns"
SET "content" = '{"version":1,"type":"single-select","options":[{"value":"yes","color":"green"},{"value":"no","color":"red"}],"fallback":null}'::jsonb
WHERE "answer_type" = 'yes_no';
--> statement-breakpoint

-- The default existed only to give the existing rows a content; new columns
-- state their own kind.
ALTER TABLE "case_law_research_columns" ALTER COLUMN "content" DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE "case_law_research_columns"
  ADD CONSTRAINT "case_law_research_columns_content_check"
  CHECK (
    (jsonb_typeof("content") = 'object'
      AND "content"->'version' = '1'::jsonb
      AND "content"->>'type' IN ('text', 'single-select', 'multi-select', 'date', 'int')
    ) IS TRUE
  ) NOT VALID;
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- the statement above added the constraint NOT VALID; the validating scan reads at most the per-organization column cap, and the rows it reads were written by the backfill above
ALTER TABLE "case_law_research_columns" VALIDATE CONSTRAINT "case_law_research_columns_content_check";
--> statement-breakpoint

UPDATE "case_law_research_answers"
SET "answer" = CASE
    WHEN "answer"->>'type' = 'yes_no' AND "answer"->>'value' IN ('yes', 'no')
      THEN jsonb_build_object('version', 1, 'type', 'single-select', 'value', "answer"->>'value')
    WHEN "answer"->>'type' = 'yes_no'
      THEN jsonb_build_object('version', 1, 'type', 'single-select', 'value', NULL)
    ELSE jsonb_build_object('version', 1, 'type', 'text', 'value', "answer"->>'value')
  END
WHERE "answer" IS NOT NULL
  AND (
    "answer"->>'type' = 'yes_no'
    OR ("answer"->>'type' = 'text' AND length(btrim(coalesce("answer"->>'value', ''))) > 0)
  );
--> statement-breakpoint

-- Everything the mapping could not express: an empty text answer has no field
-- content that means "answered", and any other stored shape is not field
-- content at all. The predicate is the negation of the constraint added below,
-- and both sides read an unknown predicate as unsatisfied, so no row can
-- survive this statement and then fail that one.
UPDATE "case_law_research_answers"
SET "state" = 'failed',
    "failure_reason" = CASE WHEN "answer"->>'type' = 'text' THEN 'not_stated' ELSE 'wrong_type' END,
    "answer" = NULL,
    "run" = NULL
WHERE "answer" IS NOT NULL
  AND (
    jsonb_typeof("answer") = 'object'
    AND "answer"->'version' = '1'::jsonb
    AND "answer"->>'type' IN ('text', 'single-select', 'multi-select', 'date', 'int')
  ) IS NOT TRUE;
--> statement-breakpoint

UPDATE "case_law_research_answers"
SET "run" = jsonb_build_object(
    'version', 1,
    'model', coalesce("run"->'model', '""'::jsonb),
    'completedAt', coalesce("run"->'completedAt', '""'::jsonb),
    'retrieved', coalesce("run"->'retrieved', 'false'::jsonb),
    'rationale', coalesce("run"->'rationale', '""'::jsonb),
    'justification', jsonb_build_object(
      'version', 1,
      'blocks', coalesce(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'kind', 'decision-passage',
              'anchorId', passage->>'anchorId',
              'excerpt', passage->>'excerpt'
            )
          )
          FROM jsonb_array_elements("run"->'passages') AS passage
        ),
        '[]'::jsonb
      )
    )
  )
WHERE "run" IS NOT NULL
  AND jsonb_typeof("run"->'passages') = 'array';
--> statement-breakpoint

ALTER TABLE "case_law_research_answers"
  ADD CONSTRAINT "case_law_research_answers_answer_content_check"
  CHECK (
    ("answer" IS NULL
      OR (jsonb_typeof("answer") = 'object'
        AND "answer"->'version' = '1'::jsonb
        AND "answer"->>'type' IN ('text', 'single-select', 'multi-select', 'date', 'int')
      )
    ) IS TRUE
  ) NOT VALID;
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- the statement above added the constraint NOT VALID; the rows it scans are the ones the two updates above rewrote, bounded by the column cap times the decisions a member has looked at
ALTER TABLE "case_law_research_answers" VALIDATE CONSTRAINT "case_law_research_answers_answer_content_check";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-column - the product no longer shows a confidence score on a cell, so nothing reads this column; its check constraint is dropped with it
ALTER TABLE "case_law_research_answers" DROP COLUMN "confidence";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-column - the kind now lives in "content", which the statements above derived from this column; keeping both would let the two disagree about what a cell may hold. Its check constraint is dropped with it
ALTER TABLE "case_law_research_columns" DROP COLUMN "answer_type";
