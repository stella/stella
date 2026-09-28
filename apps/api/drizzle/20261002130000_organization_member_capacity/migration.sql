SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Operator-seeded member bound of a usage policy. Null = the policy sets none.
ALTER TABLE "usage_policies" ADD COLUMN "max_members" integer;--> statement-breakpoint
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_max_members_positive" CHECK (max_members IS NULL OR max_members > 0);--> statement-breakpoint

-- How many members an organization may hold, or null when nothing bounds it.
-- Only an organization whose recorded access state is not
-- `self_managed_keys` and whose usage entitlement's policy sets
-- `max_members` is bounded: by that value and, for a per-seat policy, by its
-- seat count. The column is new and null on every existing policy, so no
-- existing organization is bounded until an operator sets it.
CREATE FUNCTION "organization_member_capacity"(p_organization_id text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT LEAST(
    p.max_members,
    CASE WHEN p.price_basis = 'per_seat' THEN e.seats END
  )
  FROM public.usage_entitlements e
  JOIN public.usage_policies p ON p.id = e.usage_policy_id
  JOIN public.organization_access_states s
    ON s.organization_id = e.organization_id
  WHERE e.organization_id = p_organization_id
    AND s.state <> 'self_managed_keys'
    AND p.max_members IS NOT NULL
$$;--> statement-breakpoint

-- Read on the owner connection only: the member guard below and the
-- membership hooks that refuse early.
REVOKE ALL ON FUNCTION "organization_member_capacity"(text) FROM PUBLIC;--> statement-breakpoint

-- Every path that adds a member (invitation acceptance, organization
-- creation, direct inserts) passes this one guard inside the inserting
-- transaction. The per-organization lock serializes concurrent additions, so
-- the count below includes every membership committed before this one.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; runs only as a member insert trigger, writes nothing, and reads the capacity and member count of the inserted row's organization
CREATE FUNCTION "enforce_organization_member_capacity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_capacity integer;
  v_members integer;
BEGIN
  IF public.organization_member_capacity(NEW.organization_id) IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(1843841690, hashtext(NEW.organization_id));
  v_capacity := public.organization_member_capacity(NEW.organization_id);
  IF v_capacity IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO v_members
    FROM public.member
   WHERE organization_id = NEW.organization_id;
  IF v_members >= v_capacity THEN
    RAISE EXCEPTION 'organization member capacity reached'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'member_organization_capacity';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "enforce_organization_member_capacity"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "member_organization_capacity"
BEFORE INSERT ON "member"
FOR EACH ROW EXECUTE FUNCTION "enforce_organization_member_capacity"();
