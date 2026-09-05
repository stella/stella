SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A review gate raises a task for its reviewer while the run waits, so the
-- gate shows up in My Work like any other governed work. The step row keeps
-- the task it raised: settling the gate settles the task, and completing the
-- task settles the gate, so the two are always read from one link. The FK
-- clears on task deletion so a removed task never blocks the run's history.
ALTER TABLE "flow_run_steps"
  ADD COLUMN IF NOT EXISTS "review_task_entity_id" uuid;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - drops only this foreign key by name and re-adds it in the same statement so a second run records the same constraint; no row data is touched, and the column it constrains is new in this migration. Rollback drops the constraint and the column together.
ALTER TABLE "flow_run_steps"
  DROP CONSTRAINT IF EXISTS "flow_run_steps_review_task_entity_workspace_fk",
  ADD CONSTRAINT "flow_run_steps_review_task_entity_workspace_fk"
  FOREIGN KEY ("review_task_entity_id", "workspace_id")
  REFERENCES "entities"("id", "workspace_id") ON DELETE SET NULL;--> statement-breakpoint

-- One task per gate and one gate per task: the reverse lookup a completed task
-- makes to find its gate must land on exactly one step.
CREATE UNIQUE INDEX IF NOT EXISTS "flow_run_steps_review_task_entity_key"
  ON "flow_run_steps" ("workspace_id", "review_task_entity_id")
  WHERE "review_task_entity_id" IS NOT NULL;--> statement-breakpoint

-- `flow` joins WORK_OBLIGATION_SOURCES for the task a review gate raises. The
-- schema builds this CHECK from that list, so the constraint the database
-- enforces has to be widened in step or every gate task write is rejected.
--
-- NOT VALID: this only widens the accepted set, so every stored row already
-- satisfies the new constraint and there is nothing to scan; it still applies
-- to every later INSERT and UPDATE. Dropped by name and re-added in one
-- statement so no running API task observes the column unconstrained, and a
-- second run re-records the same constraint.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with `flow` added in the same statement; no row data is touched. Rollback is the same statement with `flow` removed, which is safe once no row holds that value.
ALTER TABLE "work_obligations"
  DROP CONSTRAINT IF EXISTS "work_obligations_source_type_check",
  ADD CONSTRAINT "work_obligations_source_type_check"
  CHECK ("source_type" IN ('manual', 'calendar', 'email', 'document', 'court', 'import', 'api', 'flow')) NOT VALID;
