-- requires: 20261003123500_agent_skill_default_origin
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Whether the model may pick a skill by itself ('auto') or only run it when
-- the user invokes it ('manual'). The value list is AGENT_SKILL_INVOCATIONS.
-- A constant default adds the column without rewriting the table, and every
-- existing skill keeps today's behaviour.
ALTER TABLE "agent_skills"
  ADD COLUMN IF NOT EXISTS "invocation" text DEFAULT 'auto' NOT NULL;
--> statement-breakpoint

ALTER TABLE "agent_skills" DROP CONSTRAINT IF EXISTS "agent_skills_invocation_check";
--> statement-breakpoint

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_invocation_check"
  CHECK ("invocation" IN ('auto', 'manual')) NOT VALID;
--> statement-breakpoint

-- Commit the column and release its ACCESS EXCLUSIVE lock before validating.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, which readers and writers do not wait
-- on. A failure after this point replays the file: every step above is
-- guarded, and validating a validated constraint changes nothing.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- added NOT VALID above; the validating scan reads the skills table, bounded by the per-organization and per-user skill limits
ALTER TABLE "agent_skills" VALIDATE CONSTRAINT "agent_skills_invocation_check";
