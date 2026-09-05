SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A review gate raises a task for its reviewer while the run waits, so the
-- gate shows up in My Work like any other governed work. The step row keeps
-- the task it raised: settling the gate settles the task, and completing the
-- task settles the gate, so the two are always read from one link. The FK
-- clears on task deletion so a removed task never blocks the run's history.
ALTER TABLE "flow_run_steps"
  ADD COLUMN IF NOT EXISTS "review_task_entity_id" uuid;--> statement-breakpoint

-- A single-column reference. The tenant pair (task id, workspace id) would
-- need `ON DELETE SET NULL (review_task_entity_id)`, a column list drizzle
-- cannot declare, and an unqualified SET NULL on the pair would try to null
-- the non-null workspace column and fail the delete instead. Every lookup of
-- this column carries the workspace predicate, and RLS scopes both tables.
--
-- NOT VALID: the column is new and null everywhere, so there is nothing to
-- scan; the constraint still applies to every later write.
-- stella-migration-safety: reviewed drop-constraint - drops only this foreign key by name and re-adds it in the same statement so a second run records the same constraint; no row data is touched, and the column it constrains is new in this migration. Rollback drops the constraint and the column together.
ALTER TABLE "flow_run_steps"
  DROP CONSTRAINT IF EXISTS "flow_run_steps_review_task_entity_id_entities_id_fk",
  ADD CONSTRAINT "flow_run_steps_review_task_entity_id_entities_id_fk"
  FOREIGN KEY ("review_task_entity_id") REFERENCES "entities"("id")
  ON DELETE SET NULL NOT VALID;--> statement-breakpoint

-- One task per gate and one gate per task: the reverse lookup a completed task
-- makes to find its gate must land on exactly one step. Built inside the
-- migrator transaction: the column is new and null on every row, so the
-- build reads nothing and holds its lock for the blink the table takes to
-- scan, well inside the timeouts above.
-- squawk-ignore require-concurrent-index-creation
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
