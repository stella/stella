-- requires: 20261003122700_time_entry_approval_queue
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
-- Existing rows remain client activity, including personal matters.
ALTER TABLE "time_entries" ADD COLUMN IF NOT EXISTS "activity_group" text NOT NULL DEFAULT 'client';
--> statement-breakpoint
-- Nullable-aware readers and internal writers ship together; existing rows keep their matters.
-- squawk-ignore ban-drop-not-null
ALTER TABLE "time_entries" ALTER COLUMN "workspace_id" DROP NOT NULL;
--> statement-breakpoint
-- Replayable prefix protects interrupted concurrent index builds.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "time_entries_org_status_date_id_idx"
  ON "time_entries" ("organization_id", "status", "date_worked", "id");
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "time_entries_org_status_date_id_idx";
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_activity_group_check"
  CHECK ("activity_group" IN ('client', 'internal')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_client_workspace_check"
  CHECK ("activity_group" <> 'client' OR "workspace_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_internal_shape_check"
  CHECK ("activity_group" <> 'internal' OR (
    "workspace_id" IS NULL AND "billable" = false AND "no_charge" = false
    AND "billed_minutes" = 0 AND "rate_at_entry" = 0 AND "currency" = 'XXX'
    AND "invoice_id" IS NULL AND "work_item_id" IS NULL
    AND "task_code" IS NULL AND "activity_code" IS NULL AND "invoice_narrative" IS NULL
    AND "status" IN ('draft', 'approved'))) NOT VALID;
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - client matter access stays scoped; internal access requires ownership or approval authority in the active organization.
ALTER POLICY "time_entries_workspace_select" ON "time_entries" USING ((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
  (activity_group = 'client' AND CASE
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
  OR (
  activity_group = 'internal'
  AND EXISTS (
    SELECT 1 FROM member m
    WHERE m.organization_id = time_entries.organization_id
      AND m.user_id = (SELECT current_setting('app.user_id', true))
      AND (time_entries.user_id = (SELECT current_setting('app.user_id', true))
        OR approver_user_id = (SELECT current_setting('app.user_id', true))
        OR m.role IN ('owner', 'admin'))
  )
)
)));
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - client matter access stays scoped; internal access requires ownership or approval authority in the active organization.
ALTER POLICY "time_entries_workspace_insert" ON "time_entries" WITH CHECK (((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
  (activity_group = 'client' AND CASE
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
  OR (
  activity_group = 'internal'
  AND EXISTS (
    SELECT 1 FROM member m
    WHERE m.organization_id = time_entries.organization_id
      AND m.user_id = (SELECT current_setting('app.user_id', true))
      AND (time_entries.user_id = (SELECT current_setting('app.user_id', true))
        OR approver_user_id = (SELECT current_setting('app.user_id', true))
        OR m.role IN ('owner', 'admin'))
  )
)
)) AND (
  activity_group = 'client' OR user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
)));
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - client matter access stays scoped; internal access requires ownership or approval authority in the active organization.
ALTER POLICY "time_entries_workspace_update" ON "time_entries" USING ((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
  (activity_group = 'client' AND CASE
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
  OR (
  activity_group = 'internal'
  AND EXISTS (
    SELECT 1 FROM member m
    WHERE m.organization_id = time_entries.organization_id
      AND m.user_id = (SELECT current_setting('app.user_id', true))
      AND (time_entries.user_id = (SELECT current_setting('app.user_id', true))
        OR approver_user_id = (SELECT current_setting('app.user_id', true))
        OR m.role IN ('owner', 'admin'))
  )
)
))) WITH CHECK ((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
  (activity_group = 'client' AND CASE
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
  OR (
  activity_group = 'internal'
  AND EXISTS (
    SELECT 1 FROM member m
    WHERE m.organization_id = time_entries.organization_id
      AND m.user_id = (SELECT current_setting('app.user_id', true))
      AND (time_entries.user_id = (SELECT current_setting('app.user_id', true))
        OR approver_user_id = (SELECT current_setting('app.user_id', true))
        OR m.role IN ('owner', 'admin'))
  )
)
)));
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - client matter access stays scoped; internal access requires ownership or approval authority in the active organization.
ALTER POLICY "time_entries_workspace_delete" ON "time_entries" USING ((organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND (
  (activity_group = 'client' AND CASE
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
  OR (
  activity_group = 'internal'
  AND EXISTS (
    SELECT 1 FROM member m
    WHERE m.organization_id = time_entries.organization_id
      AND m.user_id = (SELECT current_setting('app.user_id', true))
      AND (time_entries.user_id = (SELECT current_setting('app.user_id', true))
        OR approver_user_id = (SELECT current_setting('app.user_id', true))
        OR m.role IN ('owner', 'admin'))
  )
)
)));
