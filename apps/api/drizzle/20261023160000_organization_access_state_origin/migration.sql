SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Rows that predate this discriminator already represent a completed
-- creation or rollout decision: the column's stored default reads them as
-- creations without rewriting a row. Old replicas omit the column, so the
-- default then switches to mark their reconciler inserts, which an enabled
-- creation may supersede after a rolling deployment race.
ALTER TABLE "organization_access_states"
  ADD COLUMN "origin" text DEFAULT 'creation' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_access_states"
  ALTER COLUMN "origin" SET DEFAULT 'legacy_reconcile';
--> statement-breakpoint

-- Validated after deploy by the online phase (online-migrations.ts).
ALTER TABLE "organization_access_states"
  ADD CONSTRAINT "organization_access_states_origin_domain"
    CHECK ("origin" IN ('creation', 'legacy_reconcile')) NOT VALID;
--> statement-breakpoint

-- Serialize every member admission before interpreting a missing access
-- state. The first membership bootstraps organization creation; any later
-- membership fails closed until the creation hook records the state.
-- stella-migration-safety: reviewed security-definer - fixed search path,
-- PUBLIC execute revoked; runs only as a member insert trigger, writes
-- nothing, and reads the state, capacity and member count of NEW.organization_id
CREATE OR REPLACE FUNCTION "enforce_organization_member_capacity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_capacity integer;
  v_members integer;
BEGIN
  PERFORM pg_advisory_xact_lock(1843841690, hashtext(NEW.organization_id));

  IF NOT EXISTS (
    SELECT 1
      FROM public.organization_access_states
     WHERE organization_id = NEW.organization_id
  ) THEN
    SELECT count(*) INTO v_members
      FROM public.member
     WHERE organization_id = NEW.organization_id;
    IF v_members > 0 THEN
      RAISE EXCEPTION 'organization access state missing'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'member_organization_access_state';
    END IF;
    RETURN NEW;
  END IF;

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
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION "enforce_organization_member_capacity"() FROM PUBLIC;
