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
-- CHECK is validated by the online phase after its bounded backfill.
ALTER TABLE "workspaces"
  ADD COLUMN "visibility" text DEFAULT 'admins_and_assigned' NOT NULL,
  ADD CONSTRAINT "workspaces_visibility_check"
    CHECK ("visibility" IN ('all_members', 'admins_and_assigned', 'assigned_only')) NOT VALID;
--> statement-breakpoint

-- Existing rows retain the old access rule until the bounded online repair
-- finishes. Its cursor and atomic function/view cutover are owned by
-- src/db/matter-visibility-repair.ts. NOT VALID avoids a deploy-time scan.

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

-- No database default: the application always states a visibility. A writer
-- that predates this column (an API instance still rolling out) omits it, and
-- the preceding trigger gives that row the visibility the old rule implied, so a
-- clientless matter created mid-rollout stays assigned_only rather than
-- defaulting to admins_and_assigned. CONTRACT STEP: drop the trigger and the
-- function in a later release, once no such writer can remain.
-- squawk-ignore ban-drop-default -- The preceding insert trigger supplies the legacy visibility for rolling old writers; new writers state it explicitly.
ALTER TABLE "workspaces" ALTER COLUMN "visibility" DROP DEFAULT;
--> statement-breakpoint

-- Membership loss locks all affected matters before checking the current
-- state in a separate statement. This serializes with narrowing and handoff,
-- including writers that predate application-level steward repair.
-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; reads only the persisted member's organization and assignments, locks affected matter rows, refuses stewardship loss, and writes nothing
CREATE FUNCTION "enforce_member_role_keeps_matter_leads"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id = OLD.organization_id
      AND NEW.user_id = OLD.user_id
      AND NEW.role IN ('owner', 'admin', 'member', 'intern') THEN
      RETURN NEW;
    END IF;
  ELSE
    -- Deleting the organization removes its matters too. Its parent row is
    -- already gone when cascading membership deletes run.
    IF NOT EXISTS (SELECT 1 FROM public.organization WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  PERFORM w.id
  FROM public.workspaces AS w
  WHERE w.organization_id = OLD.organization_id
    AND (w.lead_user_id = OLD.user_id OR EXISTS (
      SELECT 1 FROM public.workspace_members AS wm
      WHERE wm.workspace_id = w.id AND wm.user_id = OLD.user_id
    ))
  ORDER BY w.id
  FOR UPDATE OF w;

  IF EXISTS (
    SELECT 1 FROM public.workspaces AS w
    WHERE w.organization_id = OLD.organization_id
      AND w.visibility = 'assigned_only'
      AND w.lead_user_id = OLD.user_id
  ) THEN
    RAISE EXCEPTION 'member leads a matter visible to assigned members only'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'member_role_keeps_matter_leads';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
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
--> statement-breakpoint

CREATE TRIGGER "member_identity_keeps_matter_leads"
BEFORE DELETE OR UPDATE OF "organization_id", "user_id" ON "member"
FOR EACH ROW
EXECUTE FUNCTION "enforce_member_role_keeps_matter_leads"();
--> statement-breakpoint

-- UPDATE already holds the decisive matter row. The membership and assignment
-- loss triggers take that same row FOR UPDATE before deciding whether to refuse.
-- A usable steward is internal, belongs to this organization, and is assigned.
-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; read-only trigger checks the updated matter's persisted membership and assignment under its existing row lock
CREATE FUNCTION public.enforce_workspace_keeps_matter_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.visibility = 'assigned_only' AND NOT EXISTS (
    SELECT 1 FROM public.member AS m
    JOIN public.workspace_members AS wm ON wm.user_id = m.user_id
    WHERE m.organization_id = NEW.organization_id
      AND m.user_id = NEW.lead_user_id
      AND m.role IN ('owner', 'admin', 'member', 'intern')
      AND wm.workspace_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'assigned-only matter requires an assigned internal steward'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'workspace_keeps_matter_lead';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_workspace_keeps_matter_lead() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "workspace_keeps_matter_lead"
BEFORE UPDATE OF "lead_user_id", "visibility", "organization_id" ON "workspaces"
FOR EACH ROW
EXECUTE FUNCTION public.enforce_workspace_keeps_matter_lead();
--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; locks the old assignment's matter, reads only its persisted steward rows, refuses losing a usable steward, and writes nothing
CREATE FUNCTION public.enforce_assignment_keeps_matter_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id = OLD.workspace_id AND NEW.user_id = OLD.user_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- An absent parent means the whole matter or organization is being deleted.
  PERFORM w.id FROM public.workspaces AS w
  JOIN public.organization AS o ON o.id = w.organization_id
  WHERE w.id = OLD.workspace_id
  FOR UPDATE OF w;

  IF EXISTS (
    SELECT 1 FROM public.workspaces AS w
    JOIN public.organization AS o ON o.id = w.organization_id
    WHERE w.id = OLD.workspace_id AND w.visibility = 'assigned_only'
      AND NOT EXISTS (
        SELECT 1 FROM public.member AS m
        JOIN public.workspace_members AS wm ON wm.user_id = m.user_id
        WHERE m.organization_id = w.organization_id
          AND m.user_id = w.lead_user_id
          AND m.role IN ('owner', 'admin', 'member', 'intern')
          AND wm.workspace_id = w.id
          AND wm.id <> OLD.id
      )
  ) THEN
    RAISE EXCEPTION 'assignment removal would leave an assigned-only matter without a steward'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assignment_keeps_matter_lead';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_assignment_keeps_matter_lead() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "assignment_keeps_matter_lead"
BEFORE DELETE OR UPDATE OF "workspace_id", "user_id" ON "workspace_members"
FOR EACH ROW
EXECUTE FUNCTION public.enforce_assignment_keeps_matter_lead();
--> statement-breakpoint

-- Creating a matter: inserts the matter in the transaction's organization and,
-- when the creating member would not reach it otherwise, that member's
-- assignment, so the new matter is reachable through the rule above without
-- naming it in app.workspace_ids. It adds no other member.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; organization and user come from the transaction settings, never from arguments; inserts one matter and at most the caller's own assignment
CREATE FUNCTION public.stella_create_workspace(
  p_workspace_id uuid,
  p_client_id uuid,
  p_name text,
  p_reference text,
  p_billing_reference text,
  p_color text,
  p_lead_user_id text,
  p_visibility text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_organization_id text := NULLIF(
    pg_catalog.current_setting('app.organization_id', true),
    ''
  );
  v_user_id text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
BEGIN
  IF v_organization_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'creating a matter requires an organization member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.member m
    WHERE m.organization_id = v_organization_id
      AND m.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'creating a matter requires an organization member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The function runs as the owner, so it checks what the row policies would:
  -- the client and the lead belong to the same organization.
  IF p_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.contacts c
    WHERE c.id = p_client_id
      AND c.organization_id = v_organization_id
  ) THEN
    RAISE EXCEPTION 'the client belongs to another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_lead_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.member m
    WHERE m.organization_id = v_organization_id
      AND m.user_id = p_lead_user_id
  ) THEN
    RAISE EXCEPTION 'the matter lead is not an organization member'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.workspaces (
    id,
    organization_id,
    client_id,
    name,
    reference,
    billing_reference,
    color,
    lead_user_id,
    visibility
  )
  VALUES (
    p_workspace_id,
    v_organization_id,
    p_client_id,
    p_name,
    p_reference,
    p_billing_reference,
    p_color,
    p_lead_user_id,
    p_visibility
  );

  IF NOT public.stella_workspace_access(
    v_organization_id,
    v_user_id,
    p_workspace_id
  ) THEN
    -- The application mints ids for its own inserts; the column has no
    -- database default, so the function supplies one.
    INSERT INTO public.workspace_members (id, workspace_id, user_id)
    VALUES (pg_catalog.gen_random_uuid(), p_workspace_id, v_user_id);
  END IF;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text, text) TO stella;

--> statement-breakpoint

-- The online repair selects and holds only its bounded legacy batch; its
-- subsequent steward queries run after lock acquisition with a fresh snapshot.
CREATE FUNCTION public.stella_lock_legacy_visibility_batch(p_cursor uuid, p_size integer)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_size < 1 OR p_size > 100 THEN
    RAISE EXCEPTION 'visibility backfill batch must contain between 1 and 100 matters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_cursor IS NULL THEN
    RETURN QUERY SELECT w.id FROM public.workspaces w
      WHERE w.client_id IS NULL ORDER BY w.id LIMIT p_size FOR UPDATE;
  ELSE
    RETURN QUERY SELECT w.id FROM public.workspaces w
      WHERE w.client_id IS NULL AND w.id > p_cursor
      ORDER BY w.id LIMIT p_size FOR UPDATE;
  END IF;
END;
$$;
--> statement-breakpoint

-- Only the database migration owner runs the repair; application sessions do not.
REVOKE ALL ON FUNCTION public.stella_lock_legacy_visibility_batch(uuid, integer) FROM PUBLIC;
