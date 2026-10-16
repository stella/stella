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
-- the trigger below gives that row the visibility the old rule implied, so a
-- clientless matter created mid-rollout stays assigned_only rather than
-- defaulting to admins_and_assigned. CONTRACT STEP: drop the trigger and the
-- function in a later release, once no such writer can remain.
-- squawk-ignore ban-drop-default -- The preceding insert trigger supplies the legacy visibility for rolling old writers; new writers state it explicitly.
ALTER TABLE "workspaces" ALTER COLUMN "visibility" DROP DEFAULT;
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
  -- Lock every assignment before checking visibility. A filtered EXISTS can
  -- skip an open matter that another transaction is concurrently narrowing.
  PERFORM w.id
  FROM public.workspaces AS w
  JOIN public.workspace_members AS wm ON wm.workspace_id = w.id
  WHERE wm.user_id = NEW.user_id
    AND w.organization_id = NEW.organization_id
  ORDER BY w.id
  FOR SHARE OF w;

  -- This separate statement sees changes committed while the lock waited.
  IF EXISTS (
    SELECT 1
    FROM public.workspaces AS w
    JOIN public.workspace_members AS wm ON wm.workspace_id = w.id
    WHERE wm.user_id = NEW.user_id
      AND w.organization_id = NEW.organization_id
      AND w.visibility = 'assigned_only'
      AND w.lead_user_id = NEW.user_id
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
