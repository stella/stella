SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_action_type_domain"
  CHECK ("action_type" IN ('chat', 'anonymise', 'doc_review', 'case_law', 'background', 'subagent', 'transcription')) NOT VALID;
