SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "audit_logs"
  ADD COLUMN "feature_owner" text NOT NULL DEFAULT 'shared';
ALTER TABLE "notifications"
  ADD COLUMN "feature_owner" text NOT NULL DEFAULT 'shared';

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_feature_owner_check"
  CHECK ("feature_owner" IN ('shared', 'flows')) NOT VALID;
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_feature_owner_check"
  CHECK ("feature_owner" IN ('shared', 'flows')) NOT VALID;

UPDATE "audit_logs"
SET "feature_owner" = 'flows'
WHERE "resource_type" IN ('flow_definition', 'flow_run')
   OR (
     "resource_type" IN ('entity', 'work_obligation')
     AND EXISTS (
       SELECT 1 FROM "flow_run_steps"
       WHERE "flow_run_steps"."workspace_id" = "audit_logs"."workspace_id"
         AND "flow_run_steps"."review_task_entity_id"::text = "audit_logs"."resource_id"
     )
   )
   OR (
     "resource_type" IN ('field', 'entity_version')
     AND EXISTS (
       SELECT 1 FROM "flow_run_steps"
       WHERE "flow_run_steps"."workspace_id" = "audit_logs"."workspace_id"
         AND "flow_run_steps"."review_task_entity_id"::text = COALESCE(
           "audit_logs"."metadata" ->> 'entityId',
           "audit_logs"."changes" -> 'created' -> 'new' ->> 'entityId',
           "audit_logs"."changes" -> 'deleted' -> 'old' ->> 'entityId'
         )
     )
   );

UPDATE "notifications"
SET "feature_owner" = 'flows'
WHERE "kind" IN (
  'flow_run_completed',
  'flow_run_failed',
  'flow_run_awaiting_approval'
)
OR EXISTS (
  SELECT 1 FROM "flow_run_steps"
  WHERE "notifications"."entity_type" = 'entity'
    AND "flow_run_steps"."workspace_id" = "notifications"."workspace_id"
    AND "flow_run_steps"."review_task_entity_id"::text = "notifications"."entity_id"
);

ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_feature_owner_check";
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_feature_owner_check";
