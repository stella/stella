SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- All link writers share the parent matter lock before counting capacity.
-- Existing links may be edited in place; moves consume the target's capacity.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; locks and reads only the inserted or moved link's parent matter and its link count
CREATE FUNCTION "enforce_workspace_contact_capacity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_links integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.workspace_id = OLD.workspace_id THEN
    RETURN NEW;
  END IF;

  -- The recount needs a fresh statement snapshot after waiting for the parent
  -- lock. Require READ COMMITTED so every previously committed link is visible.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'matter contact capacity requires READ COMMITTED isolation'
      USING ERRCODE = 'feature_not_supported',
            CONSTRAINT = 'workspace_contacts_capacity_isolation';
  END IF;

  PERFORM 1 FROM public.workspaces
   WHERE id = NEW.workspace_id
     AND organization_id = NEW.organization_id
   FOR UPDATE;

  SELECT count(*) INTO v_links FROM public.workspace_contacts
   WHERE workspace_id = NEW.workspace_id;
  IF v_links >= 100 THEN
    RAISE EXCEPTION 'matter contact capacity reached'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'workspace_contacts_workspace_capacity';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "enforce_workspace_contact_capacity"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "workspace_contacts_workspace_capacity"
BEFORE INSERT OR UPDATE OF workspace_id ON "workspace_contacts"
FOR EACH ROW EXECUTE FUNCTION "enforce_workspace_contact_capacity"();
