-- stella-migration-safety: reviewed destructive-change - the DROP POLICY below is immediately followed by a CREATE POLICY of the same name on the same table, for the same command and role, whose only difference is that it also admits a NULL workspace_id; every predicate the old policy applied still applies, so no scoped writer gains a row it could not already insert and no reader is affected (the table is read only by the root worker). Rollback is the reverse pair, valid while no organization-owned page has been written yet: re-create the previous policy and restore NOT NULL. Once such a page exists the NOT NULL cannot be restored without first erasing rows that name objects still in the bucket, so a rollback past that point drains the queue first.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Organization deletion now records its own storage teardown, and part of an
-- organization's storage has never belonged to a matter: templates live at
-- {org}/templates/…, style-set packages at {org}/style-sets/…, and chat
-- attachments at {user}/… . Those pages had no workspace to name, so
-- workspace_id becomes nullable and states the scope a page came from instead
-- of forcing a matter onto keys that never had one. Matter-scoped pages, which
-- are still every page document deletion writes, keep naming their workspace.
ALTER TABLE "entity_deletion_cleanup_requests" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint

-- The insert policy has to admit the new scope. Organization-owned pages are
-- written by the root connection, which bypasses row-level security entirely,
-- so this only changes what a scoped request may write: organization_id still
-- has to be the caller's own tenant, and a page that does name a workspace is
-- still held to the caller's authorized matters.
DROP POLICY "entity_deletion_cleanup_insert" ON "entity_deletion_cleanup_requests";--> statement-breakpoint

CREATE POLICY "entity_deletion_cleanup_insert"
  ON "entity_deletion_cleanup_requests"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((workspace_id IS NULL OR (CASE
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
  END)) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
