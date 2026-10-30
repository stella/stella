-- requires: 20261030200119_retained_activity_feature_ownership
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "audit_logs"
  ADD COLUMN "feature_owner" text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_feature_owner_check"
  CHECK ("feature_owner" IN ('shared', 'flows', 'unknown')) NOT VALID;
--> statement-breakpoint
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
