SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Matter visibility is its own column instead of being implied by the client.
--
-- Until now a NULL client_id meant "personal": visible only to the matter's
-- members, never to organization owners and admins. `visibility` carries that
-- decision explicitly so a matter can have no client and still be visible to
-- the organization (internal templates, know-how, firm administration), and a
-- matter with a client can be private.
--
-- Adding the column with a constant default is a metadata-only change; the
-- CHECK is validated in the same statement against a table bounded by
-- matters per organization.
ALTER TABLE "workspaces"
  ADD COLUMN "visibility" text DEFAULT 'organization' NOT NULL,
  ADD CONSTRAINT "workspaces_visibility_check"
    CHECK ("visibility" IN ('organization', 'private'));
--> statement-breakpoint

-- Preserve today's behaviour: every matter without a client stays private, so
-- nothing becomes visible to anyone who could not already see it. Bounded by
-- its WHERE clause to the clientless matters; workspaces scale with matters,
-- not with the corpus.
UPDATE "workspaces" SET "visibility" = 'private' WHERE "client_id" IS NULL;
--> statement-breakpoint

-- No database default: the application always states a visibility. A writer
-- that predates this column (an API instance still rolling out) omits it, and
-- the trigger below gives that row the visibility the old rule implied, so a
-- clientless matter created mid-rollout stays private rather than defaulting
-- to the organization. Drop the trigger and function once no such writer can
-- remain.
ALTER TABLE "workspaces" ALTER COLUMN "visibility" DROP DEFAULT;
--> statement-breakpoint

CREATE FUNCTION public.workspaces_legacy_visibility() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.visibility := CASE
    WHEN NEW.client_id IS NULL THEN 'private'
    ELSE 'organization'
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

-- Owners and admins reach organization-visible matters without an assignment;
-- private matters only through workspace_members. Same columns and order as
-- the view it replaces, so every policy that reads it keeps working.
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
 AND w.visibility = 'organization'
WHERE m.role IN ('owner', 'admin');
