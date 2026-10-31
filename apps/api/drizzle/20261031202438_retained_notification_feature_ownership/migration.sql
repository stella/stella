-- requires: 20261031202338_retained_audit_feature_ownership
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "notifications"
  ADD COLUMN "feature_owner" text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_feature_owner_check"
  CHECK ("feature_owner" IN ('shared', 'flows', 'unknown')) NOT VALID;
--> statement-breakpoint
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
--> statement-breakpoint
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
