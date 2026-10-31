import type { OnlineIndexDeclaration } from "./online-ddl";

type FeatureRecoveryIndex = OnlineIndexDeclaration & { introducedBy: string };

export const FEATURE_RECOVERY_INDEXES = [
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "flow_runs_upload_identity_idx" ON public."flow_runs" ("definition_id", "workspace_id", ("trigger_source"->>\'entityId\')) WHERE "trigger_source"->>\'type\' = \'file-upload\'',
    definitionBody:
      "ON public.flow_runs USING btree (definition_id, workspace_id, ((trigger_source ->> 'entityId'::text))) WHERE ((trigger_source ->> 'type'::text) = 'file-upload'::text)",
    introducedBy: "20261031200938_flow_upload_replay_index",
    name: "flow_runs_upload_identity_idx",
    tableName: "flow_runs",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "flow_runs_schedule_identity_idx" ON public."flow_runs" ("definition_id", "workspace_id", ("trigger_source"->>\'dueSlot\')) WHERE "trigger_source"->>\'type\' = \'schedule\' AND "trigger_source"->>\'dueSlot\' IS NOT NULL',
    definitionBody:
      "ON public.flow_runs USING btree (definition_id, workspace_id, ((trigger_source ->> 'dueSlot'::text))) WHERE (((trigger_source ->> 'type'::text) = 'schedule'::text) AND ((trigger_source ->> 'dueSlot'::text) IS NOT NULL))",
    introducedBy: "20261031200938_flow_upload_replay_index",
    name: "flow_runs_schedule_identity_idx",
    tableName: "flow_runs",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "flow_upload_trigger_intents_retry_idx" ON public."flow_upload_trigger_intents" ("retry_at", "definition_id", "entity_id") WHERE "status" = \'pending\'',
    definitionBody:
      "ON public.flow_upload_trigger_intents USING btree (retry_at, definition_id, entity_id) WHERE (status = 'pending'::text)",
    introducedBy: "20261031201038_upload_trigger_settlements",
    name: "flow_upload_trigger_intents_retry_idx",
    tableName: "flow_upload_trigger_intents",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "pending_scout_emissions_next_attempt_idx" ON public."pending_scout_emissions" ("next_attempt_at") WHERE "status" = \'pending\'',
    definitionBody:
      "ON public.pending_scout_emissions USING btree (next_attempt_at) WHERE (status = 'pending'::text)",
    introducedBy: "20261031201138_feature_recovery_grant_waits",
    name: "pending_scout_emissions_next_attempt_idx",
    tableName: "pending_scout_emissions",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "pending_scout_emissions_awaiting_grant_idx" ON public."pending_scout_emissions" ("organization_id", "workspace_id") WHERE "status" = \'awaiting_grant\'',
    definitionBody:
      "ON public.pending_scout_emissions USING btree (organization_id, workspace_id) WHERE (status = 'awaiting_grant'::text)",
    introducedBy: "20261031201138_feature_recovery_grant_waits",
    name: "pending_scout_emissions_awaiting_grant_idx",
    tableName: "pending_scout_emissions",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "flow_upload_trigger_intents_awaiting_grant_idx" ON public."flow_upload_trigger_intents" ("organization_id", "workspace_id") WHERE "status" = \'awaiting_grant\'',
    definitionBody:
      "ON public.flow_upload_trigger_intents USING btree (organization_id, workspace_id) WHERE (status = 'awaiting_grant'::text)",
    introducedBy: "20261031201138_feature_recovery_grant_waits",
    name: "flow_upload_trigger_intents_awaiting_grant_idx",
    tableName: "flow_upload_trigger_intents",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "document_processing_runs_deadline_scout_awaiting_grant_idx" ON public."document_processing_runs" ("organization_id", "workspace_id", "id") WHERE "deadline_scout_status" = \'awaiting_grant\'',
    definitionBody:
      "ON public.document_processing_runs USING btree (organization_id, workspace_id, id) WHERE (deadline_scout_status = 'awaiting_grant'::text)",
    introducedBy: "20261031201138_feature_recovery_grant_waits",
    name: "document_processing_runs_deadline_scout_awaiting_grant_idx",
    tableName: "document_processing_runs",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "flow_runs_completion_notice_pending_idx" ON public."flow_runs" ("workspace_id", "id") WHERE "recovery_state" = \'completion-notice-pending\'',
    definitionBody:
      "ON public.flow_runs USING btree (workspace_id, id) WHERE (recovery_state = 'completion-notice-pending'::text)",
    introducedBy: "20261031201538_flow_completion_notice_recovery_index",
    name: "flow_runs_completion_notice_pending_idx",
    tableName: "flow_runs",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "flow_upload_trigger_intents_skipped_recovery_idx" ON public."flow_upload_trigger_intents" ("definition_id", "retry_at", "entity_id") WHERE "status" = \'skipped\'',
    definitionBody:
      "ON public.flow_upload_trigger_intents USING btree (definition_id, retry_at, entity_id) WHERE (status = 'skipped'::text)",
    introducedBy: "20261031201638_upload_trigger_skipped_recovery_index",
    name: "flow_upload_trigger_intents_skipped_recovery_idx",
    tableName: "flow_upload_trigger_intents",
    isUnique: false,
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "flow_upload_trigger_intents_entity_ws_idx" ON public."flow_upload_trigger_intents" ("entity_id", "workspace_id")',
    definitionBody:
      "ON public.flow_upload_trigger_intents USING btree (entity_id, workspace_id)",
    introducedBy: "20261031201938_flow_upload_receipt_entity_index",
    name: "flow_upload_trigger_intents_entity_ws_idx",
    tableName: "flow_upload_trigger_intents",
    isUnique: false,
  },
] as const satisfies readonly FeatureRecoveryIndex[];
