-- requires: 20261003122900_sanctions_monitoring_reviews
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Separate from ADD so validation does not inherit its exclusive lock.
ALTER TABLE sanctions_contact_matches VALIDATE CONSTRAINT sanctions_contact_matches_disposition_check;--> statement-breakpoint
ALTER TABLE sanctions_screening_events VALIDATE CONSTRAINT sanctions_screening_events_type_check;
