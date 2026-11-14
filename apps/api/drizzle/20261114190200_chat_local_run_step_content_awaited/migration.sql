SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- A run that ends with steps it could not send announces them, and each gets
-- a row that says it is awaited until its content arrives or its time passes.
-- stella-migration-safety: reviewed drop-constraint - the outcome check is immediately replaced by a wider NOT VALID check that also accepts awaited; every existing row still satisfies it, and no released writer stores awaited.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "chat_local_run_step_contents" DROP CONSTRAINT IF EXISTS "chat_local_run_step_contents_outcome_check";--> statement-breakpoint
ALTER TABLE "chat_local_run_step_contents" ADD CONSTRAINT "chat_local_run_step_contents_outcome_check" CHECK ("outcome" IN ('stored','too_large','run_budget_reached','awaited')) NOT VALID;--> statement-breakpoint
-- An awaited step is known by its key alone: it has no kind until its content
-- arrives. Nothing reads kind as present for a row it has not first read as
-- settled, and no released writer stores a row without one.
-- squawk-ignore ban-drop-not-null
ALTER TABLE "chat_local_run_step_contents" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_local_run_step_contents" ADD CONSTRAINT "chat_local_run_step_contents_awaited_check" CHECK (("kind" IS NULL) = ("outcome" = 'awaited')) NOT VALID;
