-- requires: 20261005090300_organization_effective_policy
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The usage policy whose limits bind an organization now, or no row when
-- nothing binds it. A live entitlement binds its own policy (with its seat
-- count). A hosted entitlement in `trialing`, `active`, `past_due` or
-- `paused` stays live until the provider cancels, and a cancelled hosted
-- entitlement stays live until its `current_period_end`. A manual
-- entitlement is live until its `current_period_end`, whatever its status.
-- The source and status lists mirror `entitlementLimitDisposition`; a
-- real-database test walks every source and status against this function.
-- Without a live entitlement, an organization whose evaluation has ended
-- (explicitly or by time) falls to the active `free` policy, if one is
-- seeded. A self-managed-keys organization or a running evaluation never
-- does.
CREATE OR REPLACE FUNCTION "organization_effective_policy"(p_organization_id text)
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
      AND CASE e.source
        WHEN 'manual' THEN e.current_period_end > now()
        ELSE (
          e.status IN ('trialing', 'active', 'past_due', 'paused')
          OR (e.status = 'cancelled' AND e.current_period_end > now())
        )
      END
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
$$;
