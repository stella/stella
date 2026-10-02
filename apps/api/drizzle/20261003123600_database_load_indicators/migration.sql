-- requires: 20260516000000_case_law_ingestion_role
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Only aggregate load indicators cross this privilege boundary. The owner
-- must retain statistics visibility; otherwise this function fails closed.
-- stella-migration-safety: reviewed security-definer - catalog-only fixed search path, validated relation, aggregate-only output, and PUBLIC execute revoked preserve least privilege without granting statistics membership
CREATE FUNCTION public.stella_database_load_indicators(target_relation regclass)
RETURNS TABLE (
  transaction_age_ms double precision,
  vacuum_active boolean,
  observed_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  indicator_grantee CONSTANT pg_catalog.name := 'stella_ingestion';
  observation timestamptz;
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = current_user AND role.rolsuper
    )
  ) THEN
    RAISE EXCEPTION 'Statistics visibility is unavailable'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'owner_lacks_visibility';
  END IF;

  IF target_relation IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = target_relation AND relation.relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'Target relation must be a registered table'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- EXECUTE is granted only to this role. SECURITY DEFINER changes current_user
  -- to the owner, while SET LOCAL ROLE leaves session_user as the login role;
  -- neither identity bounds the ingestion grantee's permitted target tables.
  IF NOT pg_catalog.has_table_privilege(indicator_grantee, target_relation, 'SELECT') THEN
    RAISE EXCEPTION 'Target relation access is unavailable'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'target_access_denied';
  END IF;

  observation := pg_catalog.clock_timestamp();
  RETURN QUERY
  SELECT
    COALESCE(MAX(EXTRACT(EPOCH FROM (observation - activity.xact_start)) * 1000), 0)::double precision,
    EXISTS (
      SELECT 1
      FROM (
        SELECT progress.pid, progress.datid, progress.relid
        FROM pg_catalog.pg_stat_progress_vacuum AS progress
        UNION ALL
        SELECT progress.pid, progress.datid, progress.relid
        FROM pg_catalog.pg_stat_progress_analyze AS progress
        JOIN pg_catalog.pg_stat_activity AS worker ON worker.pid = progress.pid
        WHERE worker.backend_type = 'autovacuum worker'
      ) AS vacuum
      JOIN pg_catalog.pg_stat_activity AS worker ON worker.pid = vacuum.pid
      WHERE vacuum.relid = target_relation
        AND worker.backend_type = 'autovacuum worker'
        AND vacuum.datid = (
          SELECT database.oid FROM pg_catalog.pg_database AS database
          WHERE database.datname = pg_catalog.current_database()
        )
    ),
    observation
  FROM pg_catalog.pg_stat_activity AS activity
  WHERE activity.datname = pg_catalog.current_database()
    AND activity.pid <> pg_catalog.pg_backend_pid()
    AND activity.xact_start IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_locks AS lock
      WHERE lock.pid = activity.pid AND lock.relation = target_relation AND lock.granted)
    AND (activity.backend_type <> 'autovacuum worker' OR activity.state IS DISTINCT FROM 'idle');
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_database_load_indicators(regclass) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_database_load_indicators(regclass) TO stella_ingestion;
