SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - the replacement check added in the same transaction only widens the accepted evaluation_ended shape and keeps every other lifecycle rule; the online phase validates it; rollback re-adds the previous check, which requires evaluation start and end timestamps for evaluation_ended.
ALTER TABLE "organization_access_states"
  DROP CONSTRAINT "organization_access_states_shape";--> statement-breakpoint
ALTER TABLE "organization_access_states"
  ADD CONSTRAINT "organization_access_states_shape" CHECK ((
    (
      state = 'self_managed_keys'
      AND evaluation_started_at IS NULL
      AND evaluation_ends_at IS NULL
      AND evaluation_ended_at IS NULL
    ) OR (
      state = 'evaluation_period'
      AND evaluation_ends_at > evaluation_started_at
      AND evaluation_ended_at IS NULL
    ) OR (
      state = 'evaluation_ended'
      AND evaluation_ended_at IS NOT NULL
      AND (
        (evaluation_started_at IS NULL AND evaluation_ends_at IS NULL)
        OR evaluation_ends_at > evaluation_started_at
      )
    )
  ) IS TRUE) NOT VALID;
