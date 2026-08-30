SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The `work.attention` scout adds `work.unacknowledged` and
-- `work.deadline_at_risk` to SIGNAL_KINDS, both with `source` origin. The
-- schema builds both CHECKs from that list, so the constraints the database
-- enforces have to be widened in step or every signal the scout emits is
-- rejected.
--
-- NOT VALID: both statements only widen the accepted set, so every stored row
-- already satisfies the new constraint and there is nothing to scan; they still
-- apply to every later INSERT and UPDATE. Each constraint is dropped by name
-- and re-added in one statement so no running API task observes the column
-- unconstrained, and a second run re-records the same constraint.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with the two work kinds added in the same statement; no row data is touched. Rollback is the same statement without those kinds, which is safe once no row holds them.
ALTER TABLE "signals"
  DROP CONSTRAINT IF EXISTS "signals_kind_check",
  ADD CONSTRAINT "signals_kind_check"
  CHECK ("kind" in ('request.submitted', 'hearing.changed', 'deadline.detected', 'contract.reviewed', 'work.unacknowledged', 'work.deadline_at_risk')) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with the two work kinds pinned to `source` origin in the same statement; no row data is touched. Rollback is the same statement without those kinds, which is safe once no row holds them.
ALTER TABLE "signals"
  DROP CONSTRAINT IF EXISTS "signals_kind_origin_check",
  ADD CONSTRAINT "signals_kind_origin_check"
  CHECK (("kind" = 'request.submitted' AND "origin" = 'manual') OR ("kind" = 'hearing.changed' AND "origin" = 'source') OR ("kind" = 'deadline.detected' AND "origin" = 'model') OR ("kind" = 'contract.reviewed' AND "origin" = 'model') OR ("kind" = 'work.unacknowledged' AND "origin" = 'source') OR ("kind" = 'work.deadline_at_risk' AND "origin" = 'source')) NOT VALID;
