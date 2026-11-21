-- requires: 20261005090200_usage_policy_free_kind
-- requires: 20261003123700_membership_role_invariants
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The usage policy whose limits bind an organization now, or no row when
-- nothing binds it. A live entitlement binds its own policy (with its seat
-- count): `trialing`, `active`, `past_due` and `paused` stay live until the
-- provider cancels, and a cancelled entitlement stays live until its
-- `current_period_end`. The status lists mirror
-- `ENTITLEMENT_LIMIT_DISPOSITION_BY_STATUS`; a real-database test walks
-- every status of that map against this function. Without a live
-- entitlement, an organization whose evaluation has ended (explicitly or by
-- time) falls to the active `free` policy, if one is seeded. A
-- self-managed-keys organization or a running evaluation never does.
CREATE FUNCTION "organization_effective_policy"(p_organization_id text)
RETURNS TABLE (
  usage_policy_id uuid,
  policy_kind text,
  price_basis text,
  max_members integer,
  storage_bytes_per_assignment bigint,
  seats integer
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH live AS (
    SELECT e.usage_policy_id AS live_policy_id, e.seats AS live_seats
    FROM public.usage_entitlements e
    WHERE e.organization_id = p_organization_id
      AND (
        e.status IN ('trialing', 'active', 'past_due', 'paused')
        OR (e.status = 'cancelled' AND e.current_period_end > now())
      )
  )
  SELECT p.id, p.kind, p.price_basis, p.max_members,
         p.storage_bytes_per_assignment, live.live_seats
  FROM live
  JOIN public.usage_policies p ON p.id = live.live_policy_id
  UNION ALL
  SELECT p.id, p.kind, p.price_basis, p.max_members,
         p.storage_bytes_per_assignment, NULL::integer
  FROM public.usage_policies p
  JOIN public.organization_access_states s
    ON s.organization_id = p_organization_id
  WHERE p.kind = 'free'
    AND p.active
    AND NOT EXISTS (SELECT 1 FROM live)
    AND (
      s.state = 'evaluation_ended'
      OR (s.state = 'evaluation_period' AND s.evaluation_ends_at <= now())
    )
$$;--> statement-breakpoint

-- Invoker rights: under the application role, row-level security limits the
-- entitlement and access-state reads to the session's own organization.
REVOKE ALL ON FUNCTION "organization_effective_policy"(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "organization_effective_policy"(text) TO "stella";--> statement-breakpoint

-- How many members an organization may hold, or null when nothing bounds it.
-- An organization whose recorded access state is not `self_managed_keys` is
-- bounded by its effective policy's `max_members` and, for a per-seat
-- policy, by its seat count. Existing grants and the member insert trigger
-- keep working unchanged.
CREATE OR REPLACE FUNCTION "organization_member_capacity"(p_organization_id text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT LEAST(
    ep.max_members,
    CASE WHEN ep.price_basis = 'per_seat' THEN ep.seats END
  )
  FROM public.organization_effective_policy(p_organization_id) ep
  JOIN public.organization_access_states s
    ON s.organization_id = p_organization_id
  WHERE s.state <> 'self_managed_keys'
    AND ep.max_members IS NOT NULL
$$;--> statement-breakpoint

-- The organization's file storage capacity in bytes, or null when nothing
-- bounds it. The free policy grants its bytes to the whole organization;
-- every other policy grants them per seat assignment.
CREATE FUNCTION "organization_storage_capacity"(p_organization_id text)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN ep.policy_kind = 'free' THEN ep.storage_bytes_per_assignment
    ELSE ep.storage_bytes_per_assignment * (
      SELECT count(*)
      FROM public.usage_seat_assignments a
      WHERE a.organization_id = p_organization_id
    )
  END
  FROM public.organization_effective_policy(p_organization_id) ep
  WHERE ep.storage_bytes_per_assignment IS NOT NULL
$$;--> statement-breakpoint

-- Read on the owner connection only, by the file usage ledger.
REVOKE ALL ON FUNCTION "organization_storage_capacity"(text) FROM PUBLIC;
