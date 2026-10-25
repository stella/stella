-- requires: 20261005090300_organization_effective_policy
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- How many members an organization may hold, or null when nothing bounds it.
-- An organization whose recorded access state is not `self_managed_keys` is
-- bounded by its effective policy: a per-seat policy by its seat count (and
-- by `max_members` when that is lower), a flat policy by `max_members` alone.
-- The free floor carries no seats, so a per-seat free policy falls back to
-- `max_members`. Existing grants and the member insert trigger keep working
-- unchanged.
CREATE OR REPLACE FUNCTION "organization_member_capacity"(p_organization_id text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE ep.price_basis
    WHEN 'per_seat' THEN LEAST(ep.max_members, ep.seats)
    ELSE ep.max_members
  END
  FROM public.organization_effective_policy(p_organization_id) ep
  JOIN public.organization_access_states s
    ON s.organization_id = p_organization_id
  WHERE s.state <> 'self_managed_keys'
$$;
