SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "entities"
  ADD COLUMN "feature_owner" text NOT NULL DEFAULT 'shared';
ALTER TABLE "audit_logs"
  ADD COLUMN "feature_owner" text NOT NULL DEFAULT 'unknown';
ALTER TABLE "notifications"
  ADD COLUMN "feature_owner" text NOT NULL DEFAULT 'unknown';

ALTER TABLE "entities"
  ADD CONSTRAINT "entities_feature_owner_check"
  CHECK ("feature_owner" IN ('shared', 'flows')) NOT VALID;
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_feature_owner_check"
  CHECK ("feature_owner" IN ('shared', 'flows', 'unknown')) NOT VALID;
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_feature_owner_check"
  CHECK ("feature_owner" IN ('shared', 'flows', 'unknown')) NOT VALID;

-- Execution provenance survives clearing a review-task foreign key.
UPDATE "audit_logs" a
SET "feature_owner" = 'flows'
WHERE a."resource_type" IN ('flow_definition', 'flow_run')
   OR a."performer_id" LIKE 'flow:%'
   OR a."performer_id" LIKE 'flow-run:%'
   OR EXISTS (
     SELECT 1 FROM "flow_runs" r
     WHERE r."workspace_id" = a."workspace_id"
       AND r."id"::text = a."run_id"
   );

UPDATE "entities" e
SET "feature_owner" = 'flows'
WHERE EXISTS (
  SELECT 1 FROM "flow_run_steps" s
  WHERE s."workspace_id" = e."workspace_id"
    AND s."review_task_entity_id" = e."id"
) OR EXISTS (
  SELECT 1 FROM "audit_logs" a
  WHERE a."workspace_id" = e."workspace_id"
    AND a."resource_type" IN ('entity', 'work_obligation')
    AND a."resource_id" = e."id"::text
    AND a."feature_owner" = 'flows'
);

-- A live entity proves shared ownership; an absent entity cannot prove it.
WITH entity_events AS (
  SELECT a."id", a."workspace_id", CASE
    WHEN a."resource_type" IN ('entity', 'work_obligation') THEN a."resource_id"
    ELSE COALESCE(
      a."metadata" ->> 'entityId',
      a."changes" -> 'created' -> 'new' ->> 'entityId',
      a."changes" -> 'deleted' -> 'old' ->> 'entityId'
    ) END AS entity_id
  FROM "audit_logs" a
  WHERE a."resource_type" IN ('entity', 'work_obligation', 'field', 'entity_version')
), resolved AS (
  SELECT a."id", CASE
    WHEN a."feature_owner" = 'flows' OR EXISTS (
      SELECT 1 FROM entity_events p
      JOIN "audit_logs" provenance ON provenance."id" = p."id"
      WHERE p."workspace_id" = target."workspace_id"
        AND p.entity_id = target.entity_id
        AND provenance."feature_owner" = 'flows'
    ) THEN 'flows'
    ELSE COALESCE(e."feature_owner", 'unknown') END AS owner
  FROM "audit_logs" a
  JOIN entity_events target ON target."id" = a."id"
  LEFT JOIN "entities" e ON e."workspace_id" = target."workspace_id"
    AND e."id"::text = target.entity_id
)
UPDATE "audit_logs" a SET "feature_owner" = resolved.owner
FROM resolved WHERE resolved."id" = a."id";

UPDATE "audit_logs" SET "feature_owner" = 'shared'
WHERE "feature_owner" = 'unknown'
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
  );

UPDATE "notifications" n
SET "feature_owner" = CASE
  WHEN n."kind" IN ('flow_run_completed', 'flow_run_failed', 'flow_run_awaiting_approval')
    OR EXISTS (
      SELECT 1 FROM "audit_logs" a
      WHERE a."workspace_id" = n."workspace_id"
        AND a."resource_type" IN ('entity', 'work_obligation')
        AND a."resource_id" = n."entity_id"
        AND a."feature_owner" = 'flows'
    ) THEN 'flows'
  WHEN n."kind" = 'mention' THEN COALESCE((
    SELECT e."feature_owner" FROM "entities" e
    WHERE e."workspace_id" = n."workspace_id" AND e."id"::text = n."entity_id"
  ), 'unknown')
  WHEN n."kind" IN ('report_export_succeeded', 'report_export_failed', 'announcement') THEN 'shared'
  ELSE 'unknown' END
WHERE n."feature_owner" = 'unknown';

ALTER TABLE "entities" VALIDATE CONSTRAINT "entities_feature_owner_check";
ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_feature_owner_check";
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_feature_owner_check";

-- stella-migration-safety: reviewed alter-policy - Persisted feature owners require current recipient admission; unknown rows stay hidden.
ALTER POLICY "audit_logs_select" ON "audit_logs" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
    "audit_logs".feature_owner = 'shared' OR (
      "audit_logs".feature_owner = 'flows'
      AND ((("audit_logs".workspace_id IS NULL AND "audit_logs".resource_type = 'flow_definition') OR CASE
  WHEN "audit_logs".workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE "audit_logs".workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END))
      AND EXISTS (
        SELECT 1 FROM member AS activity_member
        JOIN "user" AS activity_user ON activity_user.id = activity_member.user_id
        JOIN feature_enrolments AS activity_enrolment
          ON activity_enrolment.organization_id = activity_member.organization_id
          AND activity_enrolment.user_id = activity_member.user_id
          AND activity_enrolment.feature_id = 'flows'
        WHERE activity_member.organization_id = "audit_logs".organization_id
          AND activity_member.user_id = current_setting('app.user_id', true)
          AND activity_user.email_verified = true
          AND activity_user.deleted_at IS NULL
      )
    )
  ));

-- stella-migration-safety: reviewed alter-policy - Persisted feature owners require current recipient admission; unknown rows stay hidden.
ALTER POLICY "user_select" ON "notifications" USING ((
  (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))) AND (workspace_id IS NULL OR CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END)
  AND (
    "notifications".feature_owner = 'shared' OR (
      "notifications".feature_owner = 'flows'
      AND "notifications".workspace_id IS NOT NULL
      AND CASE
  WHEN "notifications".workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE "notifications".workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END
      AND EXISTS (
        SELECT 1 FROM member AS activity_member
        JOIN "user" AS activity_user ON activity_user.id = activity_member.user_id
        JOIN feature_enrolments AS activity_enrolment
          ON activity_enrolment.organization_id = activity_member.organization_id
          AND activity_enrolment.user_id = activity_member.user_id
          AND activity_enrolment.feature_id = 'flows'
        WHERE activity_member.organization_id = "notifications".organization_id
          AND activity_member.user_id = current_setting('app.user_id', true)
          AND activity_user.email_verified = true
          AND activity_user.deleted_at IS NULL
      )
    )
  )
));

-- stella-migration-safety: reviewed alter-policy - Persisted feature owners require current recipient admission; unknown rows stay hidden.
ALTER POLICY "user_update" ON "notifications" USING ((
  (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))) AND (workspace_id IS NULL OR CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END)
  AND (
    "notifications".feature_owner = 'shared' OR (
      "notifications".feature_owner = 'flows'
      AND "notifications".workspace_id IS NOT NULL
      AND CASE
  WHEN "notifications".workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE "notifications".workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END
      AND EXISTS (
        SELECT 1 FROM member AS activity_member
        JOIN "user" AS activity_user ON activity_user.id = activity_member.user_id
        JOIN feature_enrolments AS activity_enrolment
          ON activity_enrolment.organization_id = activity_member.organization_id
          AND activity_enrolment.user_id = activity_member.user_id
          AND activity_enrolment.feature_id = 'flows'
        WHERE activity_member.organization_id = "notifications".organization_id
          AND activity_member.user_id = current_setting('app.user_id', true)
          AND activity_user.email_verified = true
          AND activity_user.deleted_at IS NULL
      )
    )
  )
));
