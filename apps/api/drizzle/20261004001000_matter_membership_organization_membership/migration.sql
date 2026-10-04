-- requires: 20261003125000_provider_event_replay_audit
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A matter membership references the organization membership of the same
-- user in the matter's organization. A foreign key cannot name the matter's
-- organization, so these triggers hold the reference instead: writes check it
-- like a foreign key, and deleting the organization membership cascades.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; executes only as a workspace_members trigger and reads the matter's organization membership like a foreign key check
CREATE FUNCTION "enforce_workspace_member_organization_member"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Share-lock the matter first, so a concurrent change of its organization
  -- waits for this write or this write waits for it and then reads the new
  -- organization. Every writer of matter memberships already holds the matter
  -- row (or created it), so this adds no wait to them; the lock order stays
  -- matter, then organization membership.
  PERFORM 1
  FROM public.workspaces w
  WHERE w.id = NEW.workspace_id
  FOR SHARE OF w;
  -- Key-share the referenced membership, as a foreign key check does, so a
  -- concurrent deletion of it waits for this write or this write waits for it.
  PERFORM 1
  FROM public.member m
  JOIN public.workspaces w ON w.organization_id = m.organization_id
  WHERE w.id = NEW.workspace_id AND m.user_id = NEW.user_id
  FOR KEY SHARE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'matter membership requires organization membership'
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'workspace_members_organization_member';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "enforce_workspace_member_organization_member"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "workspace_members_organization_member"
BEFORE INSERT OR UPDATE OF workspace_id, user_id ON "workspace_members"
FOR EACH ROW EXECUTE FUNCTION "enforce_workspace_member_organization_member"();--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; executes only as a member trigger and deletes the departed member's matter memberships in that organization, as an ON DELETE CASCADE would
CREATE FUNCTION "cascade_member_workspace_memberships"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.organization_id = OLD.organization_id
     AND NEW.user_id = OLD.user_id THEN
    RETURN NULL;
  END IF;
  DELETE FROM public.workspace_members wm
  USING public.workspaces w
  WHERE w.id = wm.workspace_id
    AND w.organization_id = OLD.organization_id
    AND wm.user_id = OLD.user_id;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "cascade_member_workspace_memberships"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "member_workspace_memberships_cascade"
AFTER DELETE OR UPDATE OF organization_id, user_id ON "member"
FOR EACH ROW EXECUTE FUNCTION "cascade_member_workspace_memberships"();--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; executes only as a workspaces trigger and checks the moved matter's memberships against its new organization
CREATE FUNCTION "enforce_workspace_organization_members"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.organization_id = OLD.organization_id THEN
    RETURN NULL;
  END IF;
  -- Key-share the new organization's memberships of this matter's members, as
  -- a foreign key check does, so a concurrent departure waits for the move
  -- (and its cascade then sees the moved matter) or the move waits for the
  -- departure and the check below sees it. The update already holds the
  -- matter row, so the order matches grants: matter, then membership.
  PERFORM 1
  FROM public.workspace_members wm
  JOIN public.member m
    ON m.organization_id = NEW.organization_id
   AND m.user_id = wm.user_id
  WHERE wm.workspace_id = NEW.id
  ORDER BY m.id
  FOR KEY SHARE OF m;
  IF EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    WHERE wm.workspace_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM public.member m
        WHERE m.organization_id = NEW.organization_id
          AND m.user_id = wm.user_id
      )
  ) THEN
    RAISE EXCEPTION 'matter membership requires organization membership'
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'workspace_members_organization_member';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "enforce_workspace_organization_members"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "workspaces_organization_members"
AFTER UPDATE OF organization_id ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "enforce_workspace_organization_members"();
