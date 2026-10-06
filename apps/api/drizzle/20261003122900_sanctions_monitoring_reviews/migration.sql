-- requires: 20261003122800_sanctions_monitoring
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE sanctions_contact_matches
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_contact_fingerprint text,
  ADD COLUMN reviewed_entry_hash text;--> statement-breakpoint
ALTER TABLE sanctions_screening_events
  ADD COLUMN reviewer_id text,
  ADD COLUMN contact_fingerprint text,
  ADD COLUMN entry_hash text;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - replace the disposition check with a superset in the same transaction.
ALTER TABLE sanctions_contact_matches DROP CONSTRAINT "sanctions_contact_matches_disposition_check";--> statement-breakpoint
ALTER TABLE sanctions_contact_matches ADD CONSTRAINT "sanctions_contact_matches_disposition_check" CHECK (disposition IN ('needs-review', 'dismissed', 'confirmed')) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - replace the event check with a superset in the same transaction.
ALTER TABLE sanctions_screening_events DROP CONSTRAINT "sanctions_screening_events_type_check";--> statement-breakpoint
ALTER TABLE sanctions_screening_events ADD CONSTRAINT "sanctions_screening_events_type_check" CHECK (type IN ('new', 'changed', 'lapsed', 'reopened', 'dismissed', 'review-restored', 'confirmed')) NOT VALID;
