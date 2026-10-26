SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The mail provider's refusal of an account's address: which address, why,
-- and since when. Nullable additions; existing rows read as deliverable.
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "email_undeliverable_address" text;
--> statement-breakpoint
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "email_undeliverable_reason" text;
--> statement-breakpoint
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "email_undeliverable_at" timestamptz;
--> statement-breakpoint
-- Better Auth reads whole user rows as the scoped role during session
-- resolution, so every user column is granted to it.
GRANT SELECT (email_undeliverable_address, email_undeliverable_reason, email_undeliverable_at) ON TABLE "user" TO stella;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - removes only this migration's own check from an interrupted earlier run before adding it again.
ALTER TABLE "user"
  DROP CONSTRAINT IF EXISTS "user_email_undeliverable_check";
--> statement-breakpoint
ALTER TABLE "user"
  ADD CONSTRAINT "user_email_undeliverable_check"
    CHECK (
      ("email_undeliverable_address" IS NULL AND "email_undeliverable_reason" IS NULL AND "email_undeliverable_at" IS NULL)
      OR ("email_undeliverable_address" IS NOT NULL AND "email_undeliverable_at" IS NOT NULL AND "email_undeliverable_reason" IS NOT NULL AND "email_undeliverable_reason" IN ('hard_bounce', 'complaint', 'suppressed'))
    ) NOT VALID;
--> statement-breakpoint

-- Commit the additions and release their ACCESS EXCLUSIVE lock before
-- validating. VALIDATE takes SHARE UPDATE EXCLUSIVE, which readers and writers
-- do not wait on. A failure after this point replays the file: every step
-- above is guarded, and validating a validated constraint changes nothing.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; every existing row has all three columns null
ALTER TABLE "user" VALIDATE CONSTRAINT "user_email_undeliverable_check";
