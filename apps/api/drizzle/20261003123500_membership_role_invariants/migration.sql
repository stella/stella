-- requires: 20261003120100_organization_member_capacity
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "member" ADD CONSTRAINT "member_single_product_role"
CHECK (role IN ('owner', 'admin', 'member', 'intern', 'external')) NOT VALID;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_single_product_role"
CHECK (role IS NOT NULL AND role IN ('owner', 'admin', 'member', 'intern', 'external')) NOT VALID;--> statement-breakpoint

ALTER TABLE "member" VALIDATE CONSTRAINT "member_single_product_role";--> statement-breakpoint
ALTER TABLE "invitation" VALIDATE CONSTRAINT "invitation_single_product_role";--> statement-breakpoint

-- The capacity and ownership guards share one organization lock. Recounting
-- after acquiring it observes preceding committed membership changes.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; executes only as a member trigger and reads the old row's organization and owners
CREATE FUNCTION "enforce_organization_member_owner"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.role <> 'owner' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN
    RETURN NULL;
  END IF;
  -- A parent-first organization teardown cascades membership deletion.
  IF NOT EXISTS (SELECT 1 FROM public.organization WHERE id = OLD.organization_id) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(1843841690, hashtext(OLD.organization_id));
  IF NOT EXISTS (
    SELECT 1 FROM public.member
    WHERE organization_id = OLD.organization_id AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'organization must retain an owner'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'member_organization_owner_required';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "enforce_organization_member_owner"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "member_organization_owner_required"
AFTER DELETE OR UPDATE OF role ON "member"
FOR EACH ROW EXECUTE FUNCTION "enforce_organization_member_owner"();
