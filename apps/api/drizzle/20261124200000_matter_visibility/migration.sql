-- requires: 20261102071500_correspondence_source_maintenance
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Matter visibility becomes a setting of its own instead of being implied by
-- the client. Three levels, widest first:
--   all_members          every internal member (owner, admin, member, intern)
--   admins_and_assigned  owners and admins, plus assigned members
--   assigned_only        assigned members only
-- External members reach a matter only through an assignment, at every level.
--
-- The column is nullable and default-free, so adding it rewrites no rows. A
-- matter without a stored visibility keeps the rule it was created under: a
-- client matter is admins_and_assigned, a matter without a client is
-- assigned_only. Every row the previous release writes therefore keeps its
-- current reach during the rollout, and the current release always stores a
-- visibility on the matters it creates or changes. No backfill is needed.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "visibility" text;--> statement-breakpoint

-- Added NOT VALID; the registered online repair validates it.
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_visibility_check" CHECK ("visibility" IN ('all_members', 'admins_and_assigned', 'assigned_only')) NOT VALID;--> statement-breakpoint

-- The matter access rule, written once. Membership in the matter reaches it
-- at every visibility; without one, owners and admins reach
-- admins_and_assigned and all_members matters (and, for a matter without a
-- stored visibility, a client matter, as before), and every internal member
-- reaches all_members matters. External members never reach a matter through
-- their role. The signature, owner, privileges (including the
-- correspondence source maintenance grant) and the trusted search path stay
-- as they are.
-- stella-migration-safety: reviewed security-definer - same signature, owner and privileges; trusted search path pinned to pg_catalog, pg_temp with every application reference qualified; read-only; returns the matters one organization member reaches under the visibility rule
CREATE OR REPLACE FUNCTION public.stella_authorized_workspace_ids(
  p_organization_id text,
  p_user_id text
)
RETURNS TABLE (workspace_id uuid, workspace_status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET plan_cache_mode = force_generic_plan
AS $$
  SELECT w.id, w.status::text
  FROM public.member m
  JOIN public.workspace_members wm
    ON wm.user_id = m.user_id
  JOIN public.workspaces w
    ON w.id = wm.workspace_id
   AND w.organization_id = m.organization_id
  WHERE m.organization_id = p_organization_id
    AND m.user_id = p_user_id
  UNION
  SELECT w.id, w.status::text
  FROM public.member m
  JOIN public.workspaces w
    ON w.organization_id = m.organization_id
  WHERE m.organization_id = p_organization_id
    AND m.user_id = p_user_id
    AND m.role IN ('owner', 'admin')
    AND (
      w.visibility IN ('admins_and_assigned', 'all_members')
      OR (w.visibility IS NULL AND w.client_id IS NOT NULL)
    )
  UNION
  SELECT w.id, w.status::text
  FROM public.member m
  JOIN public.workspaces w
    ON w.organization_id = m.organization_id
  WHERE m.organization_id = p_organization_id
    AND m.user_id = p_user_id
    AND m.role IN ('owner', 'admin', 'member', 'intern')
    AND w.visibility = 'all_members'
$$;--> statement-breakpoint

-- Whether an organization role reaches a matter of this visibility without
-- an assignment: the role half of the rule above, for the application's lock
-- scopes, which must agree with it but never decide access themselves.
CREATE FUNCTION public.stella_role_reaches_matter(
  p_role text,
  p_visibility text,
  p_client_id uuid
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE COALESCE(
      p_visibility,
      CASE WHEN p_client_id IS NULL THEN 'assigned_only' ELSE 'admins_and_assigned' END
    )
    WHEN 'all_members' THEN p_role IN ('owner', 'admin', 'member', 'intern')
    WHEN 'admins_and_assigned' THEN p_role IN ('owner', 'admin')
    ELSE false
  END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_role_reaches_matter(text, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_role_reaches_matter(text, text, uuid) TO stella;--> statement-breakpoint

-- The row policies read this view. Its membership branch now asks the rule
-- above instead of repeating it; the explicit-ID branch is unchanged, so the
-- previous release's scoped transactions keep working during the rollout.
CREATE OR REPLACE VIEW public.stella_authorized_workspaces
WITH (security_barrier = true, security_invoker = false)
AS
WITH current_member AS (
  SELECT m.organization_id, m.user_id
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
SELECT a.workspace_id AS authorized_workspace_id, a.workspace_status
FROM current_member m
CROSS JOIN LATERAL public.stella_authorized_workspace_ids(
  m.organization_id,
  m.user_id
) a;--> statement-breakpoint

-- Creating a matter with a visibility. The previous seven-argument function
-- stays for the previous release's writers; it stores no visibility, so its
-- matters keep the client rule above. This one also refuses an assigned-only
-- matter for a creator who could not keep it reachable (an external member),
-- and assigns the creator whenever the rule would not reach the new matter
-- otherwise, which for an assigned-only matter is always.
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
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_organization_id text := NULLIF(
    pg_catalog.current_setting('app.organization_id', true),
    ''
  );
  v_user_id text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  v_role text;
BEGIN
  IF v_organization_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'creating a matter requires an organization member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role
  FROM public.member m
  WHERE m.organization_id = v_organization_id
    AND m.user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'creating a matter requires an organization member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_visibility IS NULL
     OR p_visibility NOT IN ('all_members', 'admins_and_assigned', 'assigned_only') THEN
    RAISE EXCEPTION 'unknown matter visibility'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_visibility = 'assigned_only'
     AND v_role NOT IN ('owner', 'admin', 'member', 'intern') THEN
    RAISE EXCEPTION 'a matter visible to assigned members only needs an assigned internal member'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'workspaces_assigned_only_steward';
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.stella_authorized_workspace_ids(v_organization_id, v_user_id) a
    WHERE a.workspace_id = p_workspace_id
  ) THEN
    -- The application mints ids for its own inserts; the column has no
    -- database default, so the function supplies one.
    INSERT INTO public.workspace_members (id, workspace_id, user_id)
    VALUES (pg_catalog.gen_random_uuid(), p_workspace_id, v_user_id);
  END IF;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text, text) TO stella;--> statement-breakpoint

-- An assigned-only matter always keeps an assigned internal member: nobody
-- else can open it, so losing the last one would leave it unreachable. One
-- check, run by every change that could lose that member: removing or moving
-- an assignment, removing a member from the organization or making them
-- external, and narrowing a matter to assigned_only. Each takes the matter's
-- stewardship lock and then reads the committed state, so two concurrent
-- removals cannot each leave the other's member as the last one. A matter
-- without a stored visibility (created before this setting) is not checked,
-- exactly as before; one being deleted is not checked either.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; called only by the stewardship triggers, reads one matter, its assignments and its organization's memberships, and writes nothing
CREATE FUNCTION public.stella_require_matter_steward(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_organization_id text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    1836282981,
    pg_catalog.hashtext(p_workspace_id::text)
  );
  SELECT w.organization_id INTO v_organization_id
  FROM public.workspaces w
  WHERE w.id = p_workspace_id
    AND w.visibility = 'assigned_only'
    AND w.status <> 'deleting';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- Application membership writes use READ COMMITTED. Higher isolation keeps
  -- a snapshot from before the lock and cannot see the preceding writer.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'matter stewardship changes require read committed transactions'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'workspaces_assigned_only_steward_read_committed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    JOIN public.member m
      ON m.user_id = wm.user_id
     AND m.organization_id = v_organization_id
    WHERE wm.workspace_id = p_workspace_id
      AND m.role IN ('owner', 'admin', 'member', 'intern')
  ) THEN
    RAISE EXCEPTION 'a matter visible to assigned members only needs an assigned internal member'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'workspaces_assigned_only_steward';
  END IF;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_require_matter_steward(uuid) FROM PUBLIC;--> statement-breakpoint

-- An assignment removed or moved away. When the member's organization
-- membership is already gone, its own trigger below made the check.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; executes only as a workspace_members trigger and checks the matter the removed assignment belonged to
CREATE FUNCTION public.enforce_workspace_member_matter_steward()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.workspace_id = OLD.workspace_id
     AND NEW.user_id = OLD.user_id THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces w
    JOIN public.member m
      ON m.organization_id = w.organization_id
     AND m.user_id = OLD.user_id
    WHERE w.id = OLD.workspace_id
      AND m.role IN ('owner', 'admin', 'member', 'intern')
  ) THEN
    RETURN NULL;
  END IF;
  PERFORM public.stella_require_matter_steward(OLD.workspace_id);
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_workspace_member_matter_steward() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "workspace_members_assigned_only_steward"
AFTER DELETE OR UPDATE OF workspace_id, user_id ON "workspace_members"
FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_member_matter_steward();--> statement-breakpoint

-- An internal member leaving the organization or becoming external. The
-- trigger name sorts before member_workspace_memberships_cascade, so it runs
-- while the member's assignments still exist and finds every matter they
-- kept reachable; the check itself counts only the remaining internal
-- members. A parent-first organization teardown is not checked.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; executes only as a member trigger and checks the assigned-only matters the departing internal member is assigned to
CREATE FUNCTION public.enforce_member_matter_steward()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.role NOT IN ('owner', 'admin', 'member', 'intern') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.role IN ('owner', 'admin', 'member', 'intern')
     AND NEW.organization_id = OLD.organization_id
     AND NEW.user_id = OLD.user_id THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization o WHERE o.id = OLD.organization_id
  ) THEN
    RETURN NULL;
  END IF;
  PERFORM public.stella_require_matter_steward(steward.workspace_id)
  FROM (
    SELECT wm.workspace_id
    FROM public.workspace_members wm
    JOIN public.workspaces w
      ON w.id = wm.workspace_id
    WHERE wm.user_id = OLD.user_id
      AND w.organization_id = OLD.organization_id
      AND w.visibility = 'assigned_only'
    ORDER BY wm.workspace_id
  ) steward;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_member_matter_steward() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "member_assigned_only_matter_steward"
AFTER DELETE OR UPDATE OF role, organization_id, user_id ON "member"
FOR EACH ROW EXECUTE FUNCTION public.enforce_member_matter_steward();--> statement-breakpoint

-- A matter narrowed to assigned_only, or created that way. Creation is
-- checked at commit, once its assignments exist.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; executes only as a workspaces trigger and checks the matter it fired for
CREATE FUNCTION public.enforce_workspace_visibility_steward()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.visibility IS DISTINCT FROM 'assigned_only' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.visibility IS NOT DISTINCT FROM 'assigned_only' THEN
    RETURN NULL;
  END IF;
  PERFORM public.stella_require_matter_steward(NEW.id);
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_workspace_visibility_steward() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "workspaces_visibility_steward"
AFTER UPDATE OF visibility ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_visibility_steward();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "workspaces_created_steward"
AFTER INSERT ON "workspaces"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_visibility_steward();
