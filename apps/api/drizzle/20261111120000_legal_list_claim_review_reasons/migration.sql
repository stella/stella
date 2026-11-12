SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Reviewer actions that change a claim's verdict (an override, a record
-- conflict's resolution, reopening a set-aside claim) now carry the
-- reviewer's reason; a status may carry one, a note never does.
--
-- Added NOT VALID and deliberately never validated: review events are
-- append-only, and those recorded before reasons were required keep their
-- payload as written. Readers report them as recorded without a reason.
-- Every new row is checked.
ALTER TABLE "legal_list_claim_review_events" ADD CONSTRAINT "legal_list_claim_review_events_reason_check"
  CHECK (CASE WHEN "payload"->'reason' IS NULL
    THEN "kind" NOT IN ('override', 'reopen', 'record-conflict')
    ELSE "kind" IN ('status', 'override', 'reopen', 'record-conflict')
      AND jsonb_typeof("payload"->'reason') = 'string'
      AND char_length(btrim("payload"->>'reason')) BETWEEN 1 AND 10000
    END) NOT VALID;
