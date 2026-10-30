-- requires: 20261030051702_signals_flows_enrolments
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The index phase can fail after DDL commits; these statements must tolerate replay.
ALTER TABLE "flow_upload_trigger_intents"
  ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS "skip_reason" text;
--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents"
      ADD CONSTRAINT "flow_upload_trigger_intents_settlement_check" CHECK (
        (status = 'pending' AND skip_reason IS NULL) OR
        (status = 'skipped' AND skip_reason IS NOT NULL AND skip_reason IN ('definition_disabled', 'trigger_no_longer_matches'))
      ) NOT VALID;
--> statement-breakpoint
