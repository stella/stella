SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Matter visibility is its own column instead of being implied by the client.
--
-- Until now a NULL client_id meant "personal": visible only to the matter's
-- members, never to organization owners and admins. `visibility` carries that
-- decision explicitly, in three levels, widest first:
--   all_members          every internal member (owner, admin, member, intern)
--   admins_and_assigned  owners and admins, plus assigned members (the old
--                        client-matter rule)
--   assigned_only        assigned members only (the old personal rule)
-- So a matter can have no client and still be open to the organization
-- (internal templates, know-how, internal administration), and a matter with
-- a client can be closed to everyone not assigned. External members never
-- reach a matter without an assignment.
--
-- Adding the column with a constant default is a metadata-only change; the
-- CHECK is validated in the same statement against a table bounded by
-- matters per organization.
ALTER TABLE "workspaces"
  ADD COLUMN "visibility" text DEFAULT 'admins_and_assigned' NOT NULL,
  ADD CONSTRAINT "workspaces_visibility_check"
    CHECK ("visibility" IN ('all_members', 'admins_and_assigned', 'assigned_only'));
--> statement-breakpoint

-- Preserve today's behaviour: every matter without a client stays
-- assigned_only and every other matter admins_and_assigned, so nothing becomes
-- visible to anyone who could not already see it. all_members is never set
-- here; only an explicit, audited change opens a matter that wide. Bounded by
-- its WHERE clause to the clientless matters; workspaces scale with matters,
-- not with the corpus.
UPDATE "workspaces" SET "visibility" = 'assigned_only' WHERE "client_id" IS NULL;
--> statement-breakpoint

-- No database default: the application always states a visibility. A writer
-- that predates this column (an API instance still rolling out) omits it, and
-- the trigger below gives that row the visibility the old rule implied, so a
-- clientless matter created mid-rollout stays assigned_only rather than
-- defaulting to admins_and_assigned. CONTRACT STEP: drop the trigger and the
-- function in a later release, once no such writer can remain.
ALTER TABLE "workspaces" ALTER COLUMN "visibility" DROP DEFAULT;
--> statement-breakpoint

CREATE FUNCTION public.workspaces_legacy_visibility() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.visibility := CASE
    WHEN NEW.client_id IS NULL THEN 'assigned_only'
    ELSE 'admins_and_assigned'
  END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER workspaces_legacy_visibility
BEFORE INSERT ON "workspaces"
FOR EACH ROW
WHEN (NEW.visibility IS NULL)
EXECUTE FUNCTION public.workspaces_legacy_visibility();
--> statement-breakpoint

-- Without an assignment, owners and admins reach admins_and_assigned and
-- all_members matters, and every internal member reaches all_members
-- matters; assigned_only matters are reached only through workspace_members.
-- Same columns and order as the view it replaces, so every policy that reads
-- it keeps working.
CREATE OR REPLACE VIEW public.stella_authorized_workspaces
WITH (security_barrier = true, security_invoker = false)
AS
WITH current_member AS (
  SELECT m.organization_id, m.user_id, m.role
  FROM public.member m
  WHERE pg_catalog.current_setting(
      'app.workspace_access_mode',
      true
    ) = 'membership'
    AND m.organization_id = NULLIF(
      pg_catalog.current_setting('app.organization_id', true),
      ''
    )
    AND m.user_id = NULLIF(
      pg_catalog.current_setting('app.user_id', true),
      ''
    )
)
SELECT
  explicit_workspace.workspace_id AS authorized_workspace_id,
  w.status AS workspace_status
FROM pg_catalog.unnest(
  COALESCE(
    NULLIF(
      pg_catalog.current_setting('app.workspace_ids', true),
      ''
    )::uuid[],
    ARRAY[]::uuid[]
  )
) AS explicit_workspace(workspace_id)
LEFT JOIN public.workspaces w
  ON w.id = explicit_workspace.workspace_id
WHERE explicit_workspace.workspace_id IS NOT NULL
UNION ALL
SELECT w.id AS authorized_workspace_id, w.status AS workspace_status
FROM current_member m
JOIN public.workspace_members wm
  ON wm.user_id = m.user_id
JOIN public.workspaces w
  ON w.id = wm.workspace_id
 AND w.organization_id = m.organization_id
UNION ALL
SELECT w.id AS authorized_workspace_id, w.status AS workspace_status
FROM current_member m
JOIN public.workspaces w
  ON w.organization_id = m.organization_id
WHERE (
    m.role IN ('owner', 'admin')
    AND w.visibility IN ('admins_and_assigned', 'all_members')
  )
  OR (
    m.role IN ('owner', 'admin', 'member', 'intern')
    AND w.visibility = 'all_members'
  );
