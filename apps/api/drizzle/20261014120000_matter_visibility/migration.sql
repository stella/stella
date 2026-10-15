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

-- Steward invariant: an assigned-only matter is managed by its lead (owners
-- and admins do not reach it), so it always has a usable lead, one who is an
-- internal member (owner, admin, member, intern) of the matter's organization
-- and assigned to it. The application keeps this in
-- apps/api/src/lib/workspaces/visibility.ts; this backfill applies the same
-- rule once.
--
-- First repair: a clientless matter whose lead is missing or no longer usable
-- (left the organization, became external, or unassigned) takes its earliest
-- assigned internal member, by assignment time then id, as lead. A matter
-- with no such member keeps its lead as it is. Bounded to clientless matters.
UPDATE "workspaces" AS w
SET "lead_user_id" = steward.user_id
FROM (
  SELECT DISTINCT ON (wm.workspace_id) wm.workspace_id, wm.user_id
  FROM "workspace_members" AS wm
  JOIN "workspaces" AS matter ON matter.id = wm.workspace_id
  JOIN "member" AS m
    ON m.user_id = wm.user_id
   AND m.organization_id = matter.organization_id
  WHERE matter.client_id IS NULL
    AND m.role IN ('owner', 'admin', 'member', 'intern')
    AND NOT EXISTS (
      SELECT 1
      FROM "workspace_members" AS lead_assignment
      JOIN "member" AS lead_member
        ON lead_member.user_id = lead_assignment.user_id
       AND lead_member.organization_id = matter.organization_id
      WHERE lead_assignment.workspace_id = matter.id
        AND lead_assignment.user_id = matter.lead_user_id
        AND lead_member.role IN ('owner', 'admin', 'member', 'intern')
    )
  ORDER BY wm.workspace_id, wm.created_at, wm.id
) AS steward
WHERE w.id = steward.workspace_id;
--> statement-breakpoint

-- Then visibility: a matter without a client stays assigned_only and every
-- other matter admins_and_assigned, so nothing becomes visible to anyone who
-- could not already see it, except a clientless matter that still has no
-- usable lead: nobody could manage it as assigned_only, so it stays
-- admins_and_assigned and owners and admins can recover it. all_members is
-- never set here; only an explicit, audited change opens a matter that wide.
-- Bounded to the clientless matters.
UPDATE "workspaces" AS w
SET "visibility" = 'assigned_only'
WHERE w.client_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM "workspace_members" AS wm
    JOIN "member" AS m
      ON m.user_id = wm.user_id
     AND m.organization_id = w.organization_id
    WHERE wm.workspace_id = w.id
      AND wm.user_id = w.lead_user_id
      AND m.role IN ('owner', 'admin', 'member', 'intern')
  );
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
  -- The creating user leads a clientless matter they made without a lead
  -- (the old writer assigns its creator), keeping the steward invariant.
  -- Without a known creator the matter stays reachable by owners and admins.
  IF NEW.client_id IS NULL THEN
    NEW.lead_user_id := COALESCE(
      NEW.lead_user_id,
      NULLIF(pg_catalog.current_setting('app.user_id', true), '')
    );
  END IF;
  NEW.visibility := CASE
    WHEN NEW.client_id IS NULL AND NEW.lead_user_id IS NOT NULL
      THEN 'assigned_only'
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
--> statement-breakpoint

-- The steward invariant under concurrency. A role change runs in the
-- membership plugin's own transaction, after the readable refusal in its
-- hook, so the guard holding the invariant lives here, on the member row the
-- change updates. Lock order matches the registered aggregate ranks: the
-- member row first (held by the UPDATE), then the matters the member is
-- assigned to FOR SHARE. Narrowing a matter or changing its lead holds the
-- matter row FOR UPDATE before reading the lead's role, so the two serialize
-- on the matter row: whichever commits second sees the first and is refused.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; runs only as a member role-update trigger, writes nothing, and share-locks then reads the matters the updated member is assigned to in that member's organization
CREATE FUNCTION "enforce_member_role_keeps_matter_leads"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT w.visibility, w.lead_user_id
      FROM public.workspaces AS w
      JOIN public.workspace_members AS wm ON wm.workspace_id = w.id
      WHERE wm.user_id = NEW.user_id
        AND w.organization_id = NEW.organization_id
      FOR SHARE OF w
    ) AS assigned_matter
    WHERE assigned_matter.visibility = 'assigned_only'
      AND assigned_matter.lead_user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'member leads a matter visible to assigned members only'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'member_role_keeps_matter_leads';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "enforce_member_role_keeps_matter_leads"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "member_role_keeps_matter_leads"
BEFORE UPDATE OF "role" ON "member"
FOR EACH ROW
WHEN (NEW.role NOT IN ('owner', 'admin', 'member', 'intern'))
EXECUTE FUNCTION "enforce_member_role_keeps_matter_leads"();
