-- requires: 20261010212000_replay_owner_policy_plans
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();
