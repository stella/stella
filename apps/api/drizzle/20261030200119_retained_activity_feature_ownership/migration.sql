-- requires: 20261030200019_system_matter_access_functions
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "entities"
  ADD COLUMN "feature_owner" text NOT NULL DEFAULT 'shared';
--> statement-breakpoint
ALTER TABLE "entities"
  ADD CONSTRAINT "entities_feature_owner_check"
  CHECK ("feature_owner" IN ('shared', 'flows')) NOT VALID;
