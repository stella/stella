SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- "The decision does not say" becomes a cell state of its own, the same for
-- every answer kind. Until now it was split by kind: a text or int cell ended
-- `failed` with the reason `not_stated`, while a select or date cell ended
-- `answered` holding its kind's empty value.
--
-- Data: both spellings become `not_stated`. A failed cell carried no run, so
-- it has none to keep; an answered cell keeps its run, so the rationale the
-- model gave stays readable beside the cell. `not_stated` then leaves the
-- failure reasons, as does `ai_unavailable`, which no code path ever wrote.
-- The reasons get a CHECK from that list, which also ties a reason to the
-- failed state: every writer already sets one exactly there.

-- stella-migration-safety: reviewed drop-constraint - replaces the state CHECK with a strictly wider set in the same transaction; rollback restores the prior CHECK once no row holds 'not_stated'
ALTER TABLE "case_law_research_answers"
  DROP CONSTRAINT "case_law_research_answers_state_check";
--> statement-breakpoint

ALTER TABLE "case_law_research_answers"
  ADD CONSTRAINT "case_law_research_answers_state_check"
  CHECK ("state" IN ('pending', 'answered', 'not_stated', 'not_allowed', 'failed')) NOT VALID;
--> statement-breakpoint

-- Bounded by the failure reason it rewrites.
UPDATE "case_law_research_answers"
SET "state" = 'not_stated',
    "failure_reason" = NULL
WHERE "state" = 'failed'
  AND "failure_reason" = 'not_stated';
--> statement-breakpoint

-- An answered cell holding its kind's empty value: a null value (select, date,
-- and text or int should one exist), an empty selection, or blank text. The
-- answer goes, since only `answered` carries one; the run stays.
UPDATE "case_law_research_answers"
SET "state" = 'not_stated',
    "answer" = NULL
WHERE "state" = 'answered'
  AND (
    coalesce(jsonb_typeof("answer"->'value'), 'null') = 'null'
    OR ("answer"->>'type' = 'multi-select' AND "answer"->'value' = '[]'::jsonb)
    OR ("answer"->>'type' = 'text' AND btrim("answer"->>'value') = '')
  );
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- the statement above added the constraint NOT VALID; the validating scan reads the research answers, bounded by the column cap times the decisions members have looked at, and the widened set rejects no row the prior one accepted
ALTER TABLE "case_law_research_answers" VALIDATE CONSTRAINT "case_law_research_answers_state_check";
--> statement-breakpoint

ALTER TABLE "case_law_research_answers"
  ADD CONSTRAINT "case_law_research_answers_failure_reason_check"
  CHECK (
    (("state" = 'failed') = ("failure_reason" IS NOT NULL)
      AND ("failure_reason" IS NULL
        OR "failure_reason" IN ('decision_unavailable', 'no_text', 'model_error', 'missing_answer', 'wrong_type', 'run_error'))
    ) IS TRUE
  ) NOT VALID;
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- the statement above added the constraint NOT VALID; the scan is bounded as above; every reason ever written is in the list once the first update has rewritten 'not_stated', and every writer sets a reason exactly on a failed cell
ALTER TABLE "case_law_research_answers" VALIDATE CONSTRAINT "case_law_research_answers_failure_reason_check";
