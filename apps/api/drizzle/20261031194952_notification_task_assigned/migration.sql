SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A notification can now say "you were assigned a task" and point at that
-- task. The kind and entity-type checks each gain one value; both are
-- replaced by wider NOT VALID checks and validated online.
-- stella-migration-safety: reviewed drop-constraint - the kind check is immediately replaced by a wider NOT VALID check that also accepts task_assigned; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" in ('mention', 'task_assigned', 'report_export_succeeded', 'report_export_failed', 'flow_run_completed', 'flow_run_failed', 'flow_run_awaiting_approval', 'announcement')) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the entity-type check is immediately replaced by a wider NOT VALID check that also accepts task; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_entity_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_entity_type_check"
  CHECK ("entity_type" is null or "entity_type" in ('entity', 'flow_run', 'report_export', 'task')) NOT VALID;
