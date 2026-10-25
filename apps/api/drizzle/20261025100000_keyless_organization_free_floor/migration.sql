SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-schema - replacing this check widens the accepted evaluation_ended shape without removing lifecycle validation.
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
