SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30min';--> statement-breakpoint

ALTER TABLE "organization_access_states"
  VALIDATE CONSTRAINT "organization_access_states_origin_domain";
