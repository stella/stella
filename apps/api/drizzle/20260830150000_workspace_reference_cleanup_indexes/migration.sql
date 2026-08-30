-- These arrays are normally evaluated by interactive read paths. Matter
-- lifecycle work also resolves them by contained workspace id, so give teardown
-- an indexed path without blocking concurrent application writes. The status
-- column makes exact-key writer ownership explicit; the constant default is a
-- metadata-only addition on supported PostgreSQL versions.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
ALTER TABLE "buffer_object_cleanup_intents"
ADD COLUMN "status" text DEFAULT 'cleanup' NOT NULL;
--> statement-breakpoint
ALTER TABLE "buffer_object_cleanup_intents"
ADD COLUMN "chat_thread_id" uuid;
--> statement-breakpoint
-- The writer locks only its opaque id and state before publishing the owning
-- database row; object keys and retry metadata remain root-only.
GRANT SELECT ("status") ON TABLE "buffer_object_cleanup_intents" TO stella;
--> statement-breakpoint
GRANT UPDATE ("status") ON TABLE "buffer_object_cleanup_intents" TO stella;
--> statement-breakpoint
-- Organization-scoped chat attachments have no matter id. Their exact-key
-- tombstone is instead pinned to its visible chat thread by the policies below
-- and fenced by the organization's shared advisory writer lock.
-- squawk-ignore ban-drop-not-null -- Organization-scoped chat writers deliberately have no matter scope; policies bind those rows to their visible chat thread and organization.
ALTER TABLE "buffer_object_cleanup_intents" ALTER COLUMN "workspace_id" DROP NOT NULL;
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - non-chat inserts retain the existing organization and authorized-workspace checks and additionally pin both key path segments; chat inserts require a visible thread in the same organization, require each stated matter to belong to that thread's persisted scope, and accept only a current-user key.
ALTER POLICY "buffer_object_cleanup_insert"
ON "buffer_object_cleanup_intents"
WITH CHECK (
  organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
  AND (
    (
      chat_thread_id IS NOT NULL
      AND pg_catalog.split_part(object_key, '/', 1) =
        (SELECT pg_catalog.current_setting('app.user_id', true))
      AND EXISTS (
        SELECT 1
        FROM chat_threads ct
        WHERE ct.id = "buffer_object_cleanup_intents".chat_thread_id
          AND ct.organization_id =
            "buffer_object_cleanup_intents".organization_id
          AND ct.user_id =
            (SELECT pg_catalog.current_setting('app.user_id', true))
          AND (
            (
              "buffer_object_cleanup_intents".workspace_id IS NULL
              AND ct.workspace_id IS NULL
              AND pg_catalog.cardinality(ct.data_workspace_ids) = 0
            )
            OR (
              "buffer_object_cleanup_intents".workspace_id IS NOT NULL
              AND (
                ct.workspace_id =
                  "buffer_object_cleanup_intents".workspace_id
                OR ct.data_workspace_ids @>
                  ARRAY["buffer_object_cleanup_intents".workspace_id]::uuid[]
              )
            )
          )
      )
    )
    OR (
      chat_thread_id IS NULL
      AND workspace_id IS NOT NULL
      AND CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF(
              (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
              ''
            )::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
      AND pg_catalog.split_part(object_key, '/', 1) = organization_id
      AND pg_catalog.split_part(object_key, '/', 2) = workspace_id::text
    )
  )
);
--> statement-breakpoint
CREATE POLICY "buffer_object_cleanup_select"
ON "buffer_object_cleanup_intents"
AS PERMISSIVE FOR SELECT TO stella
USING (
  organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
  AND (
    (
      chat_thread_id IS NOT NULL
      AND pg_catalog.split_part(object_key, '/', 1) =
        (SELECT pg_catalog.current_setting('app.user_id', true))
      AND EXISTS (
        SELECT 1
        FROM chat_threads ct
        WHERE ct.id = "buffer_object_cleanup_intents".chat_thread_id
          AND ct.organization_id =
            "buffer_object_cleanup_intents".organization_id
          AND ct.user_id =
            (SELECT pg_catalog.current_setting('app.user_id', true))
          AND (
            (
              "buffer_object_cleanup_intents".workspace_id IS NULL
              AND ct.workspace_id IS NULL
              AND pg_catalog.cardinality(ct.data_workspace_ids) = 0
            )
            OR (
              "buffer_object_cleanup_intents".workspace_id IS NOT NULL
              AND (
                ct.workspace_id =
                  "buffer_object_cleanup_intents".workspace_id
                OR ct.data_workspace_ids @>
                  ARRAY["buffer_object_cleanup_intents".workspace_id]::uuid[]
              )
            )
          )
      )
    )
    OR (
      chat_thread_id IS NULL
      AND workspace_id IS NOT NULL
      AND CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF(
              (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
              ''
            )::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
      AND pg_catalog.split_part(object_key, '/', 1) = organization_id
      AND pg_catalog.split_part(object_key, '/', 2) = workspace_id::text
    )
  )
);
--> statement-breakpoint
CREATE POLICY "buffer_object_cleanup_update"
ON "buffer_object_cleanup_intents"
AS PERMISSIVE FOR UPDATE TO stella
USING (
  organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
  AND (
    (
      chat_thread_id IS NOT NULL
      AND pg_catalog.split_part(object_key, '/', 1) =
        (SELECT pg_catalog.current_setting('app.user_id', true))
      AND EXISTS (
        SELECT 1
        FROM chat_threads ct
        WHERE ct.id = "buffer_object_cleanup_intents".chat_thread_id
          AND ct.organization_id =
            "buffer_object_cleanup_intents".organization_id
          AND ct.user_id =
            (SELECT pg_catalog.current_setting('app.user_id', true))
          AND (
            (
              "buffer_object_cleanup_intents".workspace_id IS NULL
              AND ct.workspace_id IS NULL
              AND pg_catalog.cardinality(ct.data_workspace_ids) = 0
            )
            OR (
              "buffer_object_cleanup_intents".workspace_id IS NOT NULL
              AND (
                ct.workspace_id =
                  "buffer_object_cleanup_intents".workspace_id
                OR ct.data_workspace_ids @>
                  ARRAY["buffer_object_cleanup_intents".workspace_id]::uuid[]
              )
            )
          )
      )
    )
    OR (
      chat_thread_id IS NULL
      AND workspace_id IS NOT NULL
      AND CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF(
              (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
              ''
            )::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
      AND pg_catalog.split_part(object_key, '/', 1) = organization_id
      AND pg_catalog.split_part(object_key, '/', 2) = workspace_id::text
    )
  )
);
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - deletion keeps the same scope and key predicates as insertion, so a writer can retire only the exact ownership proof it was authorized to create.
ALTER POLICY "buffer_object_cleanup_delete"
ON "buffer_object_cleanup_intents"
USING (
  organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
  AND (
    (
      chat_thread_id IS NOT NULL
      AND pg_catalog.split_part(object_key, '/', 1) =
        (SELECT pg_catalog.current_setting('app.user_id', true))
      AND EXISTS (
        SELECT 1
        FROM chat_threads ct
        WHERE ct.id = "buffer_object_cleanup_intents".chat_thread_id
          AND ct.organization_id =
            "buffer_object_cleanup_intents".organization_id
          AND ct.user_id =
            (SELECT pg_catalog.current_setting('app.user_id', true))
          AND (
            (
              "buffer_object_cleanup_intents".workspace_id IS NULL
              AND ct.workspace_id IS NULL
              AND pg_catalog.cardinality(ct.data_workspace_ids) = 0
            )
            OR (
              "buffer_object_cleanup_intents".workspace_id IS NOT NULL
              AND (
                ct.workspace_id =
                  "buffer_object_cleanup_intents".workspace_id
                OR ct.data_workspace_ids @>
                  ARRAY["buffer_object_cleanup_intents".workspace_id]::uuid[]
              )
            )
          )
      )
    )
    OR (
      chat_thread_id IS NULL
      AND workspace_id IS NOT NULL
      AND CASE
        WHEN workspace_id = ANY(
          COALESCE(
            NULLIF(
              (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
              ''
            )::uuid[],
            ARRAY[]::uuid[]
          )
        ) THEN true
        ELSE workspace_id IN (
          SELECT aw.authorized_workspace_id
          FROM public.stella_authorized_workspaces aw
        )
      END
      AND pg_catalog.split_part(object_key, '/', 1) = organization_id
      AND pg_catalog.split_part(object_key, '/', 2) = workspace_id::text
    )
  )
);
--> statement-breakpoint
ALTER TABLE "buffer_object_cleanup_intents"
ADD CONSTRAINT "buffer_object_cleanup_status_check"
CHECK ("status" IN ('cleanup', 'writing')) NOT VALID;
--> statement-breakpoint
-- Finish the additive DDL transaction before validating so the scan does not
-- retain its earlier locks. The remaining index work must also run outside a
-- transaction; Drizzle gets a fresh transaction at the end to record success.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- PostgreSQL validates the preceding NOT VALID constraint outside the additive DDL transaction so its scan does not retain earlier locks.
ALTER TABLE "buffer_object_cleanup_intents" VALIDATE CONSTRAINT "buffer_object_cleanup_status_check";
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- These retry drops target only indexes introduced by this migration; an
-- interrupted concurrent build can leave an INVALID index that must be replaced.
DROP INDEX CONCURRENTLY IF EXISTS "buffer_object_cleanup_workspace_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- the retry drop above removes an INVALID build before recreation
CREATE INDEX CONCURRENTLY "buffer_object_cleanup_workspace_idx"
ON "buffer_object_cleanup_intents" ("workspace_id", "id");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "buffer_object_cleanup_organization_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- the retry drop above removes an INVALID build before recreation
CREATE INDEX CONCURRENTLY "buffer_object_cleanup_organization_idx"
ON "buffer_object_cleanup_intents" ("organization_id", "id");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_threads_context_matter_ids_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- the retry drop above removes an INVALID build before recreation
CREATE INDEX CONCURRENTLY "chat_threads_context_matter_ids_idx"
ON "chat_threads" USING gin ("context_matter_ids");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_threads_data_workspace_ids_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- the retry drop above removes an INVALID build before recreation
CREATE INDEX CONCURRENTLY "chat_threads_data_workspace_ids_idx"
ON "chat_threads" USING gin ("data_workspace_ids");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "docx_suggestions_source_data_workspace_ids_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- the retry drop above removes an INVALID build before recreation
CREATE INDEX CONCURRENTLY "docx_suggestions_source_data_workspace_ids_idx"
ON "docx_suggestions" USING gin ("source_data_workspace_ids");
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
