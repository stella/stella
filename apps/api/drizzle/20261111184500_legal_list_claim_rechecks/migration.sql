-- requires: 20261111120000_legal_list_claim_review_reasons
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Two reviewer actions join the append-only review log: `fact-link` points a
-- claim at a fact (a reason may be given), and `recheck` records a claim
-- graded again with the grade it got (no reason: the grade rests on the
-- facts it pins). The kind check and the reason check are built from
-- CLAIM_REVIEW_EVENT_KINDS and CLAIM_REVIEW_REASON_RULE, so both widen here.
--
-- Each is dropped by name and re-added in the same statement, so no running
-- API task sees the column unconstrained, and a second run re-records the
-- same constraints. Both only widen what is accepted, so every stored row
-- still satisfies them. They are added NOT VALID: the kind check would scan
-- the whole log under the table lock to prove what the narrower check
-- already proved, and the reason check was added NOT VALID on purpose
-- (events from before reasons were required keep their payload as written).
-- Every new row is checked.
-- stella-migration-safety: reviewed drop-constraint - drops only these two check constraints by name and re-adds each, widened to the two new kinds, in the same statement; no row data is touched. Rollback is the same statement with the previous lists, safe once no row holds either new kind.
ALTER TABLE "legal_list_claim_review_events"
  DROP CONSTRAINT IF EXISTS "legal_list_claim_review_events_kind_check",
  ADD CONSTRAINT "legal_list_claim_review_events_kind_check"
  CHECK ("kind" IN ('status', 'override', 'note', 'reopen', 'record-conflict', 'fact-link', 'recheck')) NOT VALID,
  DROP CONSTRAINT IF EXISTS "legal_list_claim_review_events_reason_check",
  ADD CONSTRAINT "legal_list_claim_review_events_reason_check"
  CHECK (CASE WHEN "payload"->'reason' IS NULL
    THEN "kind" NOT IN ('override', 'reopen', 'record-conflict')
    ELSE "kind" IN ('status', 'override', 'reopen', 'record-conflict', 'fact-link')
      AND jsonb_typeof("payload"->'reason') = 'string'
      AND char_length(btrim("payload"->>'reason')) BETWEEN 1 AND 10000
    END) NOT VALID;
