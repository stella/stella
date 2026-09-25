SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-column - no code path ever read or wrote auto_invoke_hint, so every stored value is NULL and nothing is lost; rollback re-adds the nullable column
ALTER TABLE "agent_skills" DROP COLUMN "auto_invoke_hint";
