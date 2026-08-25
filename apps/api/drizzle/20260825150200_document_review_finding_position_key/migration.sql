SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint

-- A finding judges a position. There is no second finding shape and no second
-- outcome vocabulary: a reference comparison reaches the same verdicts a tier
-- match does, so its assessment maps onto them once, here.

ALTER TABLE "document_review_findings"
  ADD COLUMN IF NOT EXISTS "position_title" varchar(256);--> statement-breakpoint

-- A reference-kind row named its subject by topic id; that id became the
-- derived position's sourceId in the run's lifted snapshot.
UPDATE "document_review_findings"
   SET "position_id" = "topic_id"
 WHERE "position_id" IS NULL;--> statement-breakpoint

UPDATE "document_review_findings"
   SET "position_title" = "topic_title"
 WHERE "position_title" IS NULL;--> statement-breakpoint

-- aligned -> compliant, different -> deviation, missing-from-target -> missing,
-- additional-in-target -> additional, deal-specific and not-comparable ->
-- not-applicable. An unrecognized value is not silently kept: it becomes
-- not-applicable, the outcome that asserts nothing.
UPDATE "document_review_findings"
   SET "outcome" = CASE "outcome"
         WHEN 'aligned' THEN 'compliant'
         WHEN 'different' THEN 'deviation'
         WHEN 'missing-from-target' THEN 'missing'
         WHEN 'additional-in-target' THEN 'additional'
         ELSE 'not-applicable'
       END,
       -- The payload follows the outcome onto the single finding shape:
       -- `assessment` becomes the verdict, the target citations become the
       -- finding's own citations, and the difference is typed as language,
       -- which is all a pre-lift row can honestly claim.
       "payload" = jsonb_build_object(
         'finding',
         ("payload"->'finding' - 'assessment' - 'targetCitations' - 'findingId' - 'topicId')
         || jsonb_build_object(
              'positionId', to_jsonb("topic_id"::text),
              'standardSource', 'reference',
              'verdict', CASE "payload"->'finding'->>'assessment'
                WHEN 'aligned' THEN '"compliant"'::jsonb
                WHEN 'different' THEN '"deviation"'::jsonb
                WHEN 'missing-from-target' THEN '"missing"'::jsonb
                WHEN 'additional-in-target' THEN '"additional"'::jsonb
                ELSE '"not-applicable"'::jsonb
              END,
              'delta', '{"kind":"language"}'::jsonb,
              'severity', COALESCE("payload"->'finding'->'severity', '"medium"'::jsonb),
              'extracted', 'null'::jsonb,
              'citations', COALESCE("payload"->'finding'->'targetCitations', '[]'::jsonb),
              'rationale', CASE
                WHEN "payload"->'finding'->'explanation'->>'type' = 'comparison'
                  THEN COALESCE("payload"->'finding'->'explanation'->'text', 'null'::jsonb)
                ELSE 'null'::jsonb
              END
            )
       )
 WHERE "check_kind" = 'reference';--> statement-breakpoint

-- A tier-graded row already carried every field but the two the single shape
-- adds, so it only gains those.
UPDATE "document_review_findings"
   SET "payload" = jsonb_build_object(
         'finding',
         ("payload"->'finding')
         || jsonb_build_object(
              'standardSource', 'tiers',
              'delta', '{"kind":"language"}'::jsonb
            )
       )
 WHERE "check_kind" = 'playbook';--> statement-breakpoint

-- Both columns were filled for every row by the statements above, in this same
-- transaction, and the DROP COLUMN below already takes an ACCESS EXCLUSIVE lock
-- on this table: a nullable column plus a CHECK would not shorten the lock
-- window, only leave the invariant stated twice.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE "document_review_findings" ALTER COLUMN "position_id" SET NOT NULL;--> statement-breakpoint

-- squawk-ignore adding-not-nullable-field
ALTER TABLE "document_review_findings" ALTER COLUMN "position_title" SET NOT NULL;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - the per-check-kind outcome vocabulary is replaced by the single one below, and the check-kind column itself goes with it.
ALTER TABLE "document_review_findings"
  DROP CONSTRAINT IF EXISTS "document_review_findings_outcome_check";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - check_kind is dropped in this migration, so a constraint over it cannot survive it.
ALTER TABLE "document_review_findings"
  DROP CONSTRAINT IF EXISTS "document_review_findings_check_kind_values_check";--> statement-breakpoint

ALTER TABLE "document_review_findings"
  ADD CONSTRAINT "document_review_findings_outcome_check"
  CHECK (
    "outcome" IS NULL
    OR "outcome" IN (
      'compliant', 'fallback', 'deviation', 'missing', 'additional', 'not-applicable'
    )
  ) NOT VALID;--> statement-breakpoint

-- The three index statements below stay inside the migrator transaction, which
-- already holds ACCESS EXCLUSIVE on this table for the column rewrites around
-- them. Building concurrently would have to split that transaction and could
-- not shorten the lock window; it would only make the key swap non-atomic, so a
-- failed retry could leave the table with neither upsert key.
-- stella-migration-safety: reviewed drop-object - the old upsert key included the check kind; the position key below replaces it and the two cannot coexist (a run holds one finding per position).
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS "document_review_findings_run_topic_kind_uidx";--> statement-breakpoint

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "document_review_findings_run_position_uidx"
  ON "document_review_findings" ("run_id", "position_id");--> statement-breakpoint

-- The decision overlay: how an organization decided one position across every
-- run that graded it.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "document_review_findings_org_position_idx"
  ON "document_review_findings" ("organization_id", "position_id");--> statement-breakpoint

-- stella-migration-safety: reviewed drop-column - check_kind, topic_id and topic_title are superseded by the single finding shape keyed on position_id, backfilled above; the pre-lift payload for a reference row is reconstructible from the run's basis_v1 snapshot.
ALTER TABLE "document_review_findings"
  DROP COLUMN IF EXISTS "check_kind",
  DROP COLUMN IF EXISTS "topic_id",
  DROP COLUMN IF EXISTS "topic_title";
