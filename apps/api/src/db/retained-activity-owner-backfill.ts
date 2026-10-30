import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import { RETAINED_ACTIVITY_CONSTRAINTS } from "./feature-recovery-constraint-validation";
import {
  readBackfillCheckpointCompletion,
  readConstraintCompletion,
} from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";

const REPAIR_NAME = "retained-activity-owners";
const PHASE_COMPLETE = "complete";

const batchWindow = (cursor: string | null) =>
  cursor === null
    ? "ORDER BY id LIMIT $1"
    : "WHERE id > $1::uuid ORDER BY id LIMIT $2";

const PHASES = [
  {
    name: "audit-provenance",
    tableName: "audit_logs",
    sql: (
      cursor: string | null,
    ) => `WITH batch AS MATERIALIZED (SELECT id FROM public."audit_logs" ${batchWindow(cursor)}), changed AS (UPDATE public."audit_logs" a
SET "feature_owner" = 'flows'
WHERE a.id IN (SELECT id FROM batch) AND (a."resource_type" IN ('flow_definition', 'flow_run')
   OR a."performer_id" LIKE 'flow:%'
   OR a."performer_id" LIKE 'flow-run:%'
   OR EXISTS (
     SELECT 1 FROM public."flow_runs" r
     WHERE r."workspace_id" = a."workspace_id"
       AND r."id"::text = a."run_id"
   )) RETURNING a.id) SELECT (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS cursor, (SELECT count(*)::integer FROM batch) AS scanned, (SELECT count(*)::integer FROM changed) AS changed`,
  },
  {
    name: "entities",
    tableName: "entities",
    sql: (
      cursor: string | null,
    ) => `WITH batch AS MATERIALIZED (SELECT id FROM public."entities" ${batchWindow(cursor)}), changed AS (UPDATE public."entities" e
SET "feature_owner" = 'flows'
WHERE e.id IN (SELECT id FROM batch) AND (EXISTS (
  SELECT 1 FROM public."flow_run_steps" s
  WHERE s."workspace_id" = e."workspace_id"
    AND s."review_task_entity_id" = e."id"
) OR EXISTS (
  SELECT 1 FROM public."audit_logs" a
  WHERE a."workspace_id" = e."workspace_id"
    AND a."resource_type" IN ('entity', 'work_obligation')
    AND a."resource_id" = e."id"::text
    AND a."feature_owner" = 'flows'
)) RETURNING e.id) SELECT (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS cursor, (SELECT count(*)::integer FROM batch) AS scanned, (SELECT count(*)::integer FROM changed) AS changed`,
  },
  {
    name: "audit-entities",
    tableName: "audit_logs",
    sql: (
      cursor: string | null,
    ) => `WITH batch AS MATERIALIZED (SELECT id FROM public."audit_logs" ${batchWindow(cursor)}), entity_events AS NOT MATERIALIZED (
  SELECT a."id", a."workspace_id", CASE
    WHEN a."resource_type" IN ('entity', 'work_obligation') THEN a."resource_id"
    ELSE COALESCE(
      a."metadata" ->> 'entityId',
      a."changes" -> 'created' -> 'new' ->> 'entityId',
      a."changes" -> 'deleted' -> 'old' ->> 'entityId'
    ) END AS entity_id
  FROM public."audit_logs" a
  WHERE a."resource_type" IN ('entity', 'work_obligation', 'field', 'entity_version')
), resolved AS (
  SELECT a."id", CASE
    WHEN a."feature_owner" = 'flows' OR EXISTS (
      SELECT 1 FROM entity_events p
      JOIN public."audit_logs" provenance ON provenance."id" = p."id"
      WHERE p."workspace_id" = target."workspace_id"
        AND p.entity_id = target.entity_id
        AND provenance."feature_owner" = 'flows'
    ) THEN 'flows'
    ELSE COALESCE(e."feature_owner", 'unknown') END AS owner
  FROM public."audit_logs" a
  JOIN entity_events target ON target."id" = a."id"
  LEFT JOIN public."entities" e ON e."workspace_id" = target."workspace_id"
    AND e."id"::text = target.entity_id
  WHERE a."id" IN (SELECT id FROM batch)
) , changed AS (UPDATE public."audit_logs" a SET "feature_owner" = resolved.owner
FROM resolved WHERE resolved."id" = a."id" AND a."feature_owner" IS DISTINCT FROM resolved.owner RETURNING a.id) SELECT (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS cursor, (SELECT count(*)::integer FROM batch) AS scanned, (SELECT count(*)::integer FROM changed) AS changed`,
  },
  {
    name: "audit-shared",
    tableName: "audit_logs",
    sql: (
      cursor: string | null,
    ) => `WITH batch AS MATERIALIZED (SELECT id FROM public."audit_logs" ${batchWindow(cursor)}), changed AS (UPDATE public."audit_logs" target SET "feature_owner" = 'shared'
WHERE target.id IN (SELECT id FROM batch) AND ("feature_owner" = 'unknown'
  AND "resource_type" IN (
    'service_oauth_client',
    'legal_resolve',
    'audit_log',
    'agent_skill',
    'agent_skill_comment',
    'agent_skill_proposal',
    'ai_memory',
    'announcement',
    'billing_code',
    'case_law_matter_link',
    'case_law_decision_annotation',
    'case_law_reader_answer',
    'case_law_research_column',
    'chat_file',
    'chat_message',
    'chat_thread',
    'clause',
    'clause_category',
    'clause_template_link',
    'clause_variant',
    'contact',
    'contact_directory',
    'correspondence',
    'document_type',
    'usage_allocation',
    'usage_entitlement',
    'usage_event',
    'usage_provider_event',
    'desktop_edit_session',
    'bilingual_translation_run',
    'document_translation_run',
    'document_review_run',
    'expense',
    'feedback_report',
    'file_comparison',
    'folio_collab_room',
    'signal',
    'invoice',
    'personal_api_key',
    'machine_api_key',
    'legal_list',
    'legal_list_generation',
    'legal_list_item',
    'legal_list_verification',
    'mcp_gateway_tool',
    'organization_settings',
    'pdf_signing_session',
    'playbook',
    'property',
    'rate_entry',
    'report_export',
    'rate_table',
    'saved_search',
    'search_history',
    'seller_profile',
    'saved_time_narrative',
    'vat_rate',
    'number_series',
    'statute_annotation',
    'style_set',
    'template',
    'template_lookup_format',
    'time_entry',
    'time_daily_target',
    'time_timer',
    'user_file',
    'view',
    'view_template',
    'workspace',
    'workspace_contact',
    'workspace_member'
  )) RETURNING target.id) SELECT (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS cursor, (SELECT count(*)::integer FROM batch) AS scanned, (SELECT count(*)::integer FROM changed) AS changed`,
  },
  {
    name: "notifications",
    tableName: "notifications",
    sql: (
      cursor: string | null,
    ) => `WITH batch AS MATERIALIZED (SELECT id FROM public."notifications" ${batchWindow(cursor)}), changed AS (UPDATE public."notifications" n
SET "feature_owner" = CASE
  WHEN n."kind" IN ('flow_run_completed', 'flow_run_failed', 'flow_run_awaiting_approval')
    OR EXISTS (
      SELECT 1 FROM public."audit_logs" a
      WHERE a."workspace_id" = n."workspace_id"
        AND a."resource_type" IN ('entity', 'work_obligation')
        AND a."resource_id" = n."entity_id"
        AND a."feature_owner" = 'flows'
    ) THEN 'flows'
  WHEN n."kind" = 'mention' THEN COALESCE((
    SELECT e."feature_owner" FROM public."entities" e
    WHERE e."workspace_id" = n."workspace_id" AND e."id"::text = n."entity_id"
  ), 'unknown')
  WHEN n."kind" IN ('report_export_succeeded', 'report_export_failed', 'announcement') THEN 'shared'
  ELSE 'unknown' END
WHERE n.id IN (SELECT id FROM batch) AND (n."feature_owner" = 'unknown') RETURNING n.id) SELECT (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS cursor, (SELECT count(*)::integer FROM batch) AS scanned, (SELECT count(*)::integer FROM changed) AS changed`,
  },
] as const;

type RetainedActivityBackfillOptions = {
  clock?: () => number;
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
};

type RunPhaseOptions = {
  connection: OnlineMigrationConnection;
  phase: (typeof PHASES)[number];
  runtime: RetainedActivityBackfillOptions;
};

const runPhase = async ({
  connection,
  phase,
  runtime: options,
}: RunPhaseOptions) => {
  const runtime = createBackfillRuntime({
    name: `${REPAIR_NAME}:${phase.name}`,
    tableName: phase.tableName,
    initialSize: 128,
    config: { ...defaultConfig, maxSize: 2048 },
    connection,
    readVerdict: options.readVerdict,
    clock: options.clock,
  });
  try {
    const pass = await runBackfillPass({
      holdPolicy: "propagate",
      sleep: options.sleep ?? Bun.sleep,
      step: async () => {
        const result = await runtime.step(async ({ tx, size, cursor }) => {
          if (cursor === PHASE_COMPLETE) {
            return {
              cursor,
              done: false,
              value: { type: "complete" as const },
            };
          }
          const row = (
            await tx.query(
              phase.sql(cursor),
              cursor === null ? [size] : [cursor, size],
            )
          ).at(0);
          if (
            !isRecord(row) ||
            !(row["cursor"] === null || typeof row["cursor"] === "string") ||
            typeof row["scanned"] !== "number" ||
            typeof row["changed"] !== "number"
          ) {
            return panic(
              `Retained activity phase ${phase.name} returned invalid progress`,
            );
          }
          const complete = row["scanned"] === 0;
          if (!complete && row["cursor"] === null) {
            return panic(
              "A nonempty retained activity batch must advance its cursor",
            );
          }
          // The phase's terminal cursor commits with its last batch. The
          // enclosing repair completes only after all phases and validations.
          return {
            cursor: complete ? PHASE_COMPLETE : row["cursor"],
            done: false,
            value: {
              type: complete ? ("complete" as const) : ("advanced" as const),
            },
          };
        });
        return { ...result, done: result.value.type === "complete" };
      },
    });
    if (pass.isErr()) {
      throw pass.error;
    }
  } finally {
    await runtime.close();
  }
};

export const createRetainedActivityOwnerBackfill = (
  options: RetainedActivityBackfillOptions = {},
): OnlineRepair => ({
  introducedBy: "20261030200319_retained_notification_feature_ownership",
  name: REPAIR_NAME,
  readCompletion: async (connection) => {
    for (const phase of PHASES) {
      const name = `${REPAIR_NAME}:${phase.name}`;
      const checkpoint = (
        await connection.query(
          "SELECT cursor FROM public.database_backfill_states WHERE name = $1",
          [name],
        )
      ).at(0);
      if (isRecord(checkpoint) && checkpoint["cursor"] === PHASE_COMPLETE) {
        continue;
      }
      return await readBackfillCheckpointCompletion({
        connection,
        backfillName: name,
        repairName: REPAIR_NAME,
        reason: `Retained activity phase ${phase.name} has not completed`,
      });
    }
    for (const constraint of RETAINED_ACTIVITY_CONSTRAINTS) {
      const state = await readConstraintCompletion({
        connection,
        ...constraint,
        repairName: REPAIR_NAME,
      });
      if (state.type !== "complete") {
        return state;
      }
    }
    return { type: "complete" };
  },
  repair: async (connection, tables) => {
    for (const phase of PHASES) {
      const name = `${REPAIR_NAME}:${phase.name}`;
      const checkpoint = (
        await connection.query(
          "SELECT cursor FROM public.database_backfill_states WHERE name = $1",
          [name],
        )
      ).at(0);
      if (isRecord(checkpoint) && checkpoint["cursor"] === PHASE_COMPLETE) {
        continue;
      }
      await runPhase({ connection, phase, runtime: options });
    }
    return await validateOnlineConstraints({
      connection,
      tables,
      constraints: RETAINED_ACTIVITY_CONSTRAINTS,
    });
  },
});

export const RETAINED_ACTIVITY_OWNER_BACKFILL =
  createRetainedActivityOwnerBackfill();
