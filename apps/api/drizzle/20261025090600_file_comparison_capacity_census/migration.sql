-- requires: 20260920120000_file_comparison_uploads
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Reservation admission counts every member's retained comparison files in the
-- organization, while row policies show a member only their own rows. The
-- census returns totals only, for the transaction's organization and member.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked, read-only; organization and user come from the transaction settings, never from arguments; returns four aggregate totals and no row
CREATE FUNCTION public.file_comparison_outstanding_capacity()
RETURNS TABLE (
  organization_rows integer,
  organization_bytes double precision,
  user_rows integer,
  user_bytes double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    count(*)::integer,
    coalesce(sum(u.declared_size), 0)::double precision,
    (count(*) FILTER (
      WHERE u.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
    ))::integer,
    coalesce(sum(u.declared_size) FILTER (
      WHERE u.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
    ), 0)::double precision
  FROM public.file_comparison_uploads u
  WHERE u.organization_id = (
    SELECT pg_catalog.current_setting('app.organization_id', true)
  )
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.file_comparison_outstanding_capacity() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.file_comparison_outstanding_capacity() TO stella;
