-- requires: 20261003123600_database_load_indicators
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE public.database_pressure_cache (
  instance_identifier text PRIMARY KEY,
  refresh_token text,
  next_refresh_at timestamptz NOT NULL,
  snapshot jsonb
);--> statement-breakpoint
ALTER TABLE public.database_pressure_cache ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY database_pressure_cache_owner_access ON public.database_pressure_cache FOR ALL TO public
USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_pressure_cache'::regclass))
WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_pressure_cache'::regclass));--> statement-breakpoint

-- Only aggregate readings cross this boundary; invisible statistics fail closed.
-- stella-migration-safety: reviewed security-definer - fixed catalog search path, aggregate-only output and explicit ingestion grant
CREATE FUNCTION public.stella_database_pressure_indicators()
RETURNS TABLE(active_sessions double precision, replication_lag_ms double precision, observed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper)) THEN
    RAISE EXCEPTION 'Statistics visibility is unavailable' USING ERRCODE = 'insufficient_privilege', DETAIL = 'owner_lacks_visibility';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::double precision FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND state = 'active' AND pid <> pg_catalog.pg_backend_pid()),
    CASE WHEN pg_catalog.pg_is_in_recovery() THEN NULL::double precision
      WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_stat_replication WHERE state <> 'streaming' OR (replay_lag IS NULL AND replay_lsn IS DISTINCT FROM pg_catalog.pg_current_wal_lsn())) THEN NULL::double precision
      ELSE (SELECT COALESCE(max(EXTRACT(EPOCH FROM replay_lag) * 1000), 0)::double precision FROM pg_catalog.pg_stat_replication) END,
    pg_catalog.clock_timestamp();
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_database_pressure_indicators() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_database_pressure_indicators() TO stella_ingestion;--> statement-breakpoint

-- Claiming refresh admission is a short transaction, never held across AWS I/O.
-- Ten minutes is the fleet-wide lower bound even on errors and process restarts.
-- stella-migration-safety: reviewed security-definer - aggregate-only cache, bounded identifier and fixed refresh interval, no tenant data
CREATE FUNCTION public.stella_database_pressure_cache_claim(instance text, token text)
RETURNS TABLE(claimed boolean, snapshot jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE admitted boolean;
BEGIN
  IF length(instance) NOT BETWEEN 1 AND 255 OR length(token) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'Invalid pressure cache identity' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.database_pressure_cache AS cache(instance_identifier, refresh_token, next_refresh_at)
  VALUES (instance, token, clock_timestamp() + interval '10 minutes')
  ON CONFLICT ON CONSTRAINT database_pressure_cache_pkey DO UPDATE SET refresh_token = token, next_refresh_at = clock_timestamp() + interval '10 minutes'
  WHERE cache.next_refresh_at <= clock_timestamp();
  admitted := FOUND;
  RETURN QUERY SELECT admitted, cache.snapshot FROM public.database_pressure_cache AS cache WHERE instance_identifier = instance;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_database_pressure_cache_claim(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_database_pressure_cache_claim(text, text) TO stella_ingestion;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - compare-and-set refresh token, aggregate snapshot only and fixed catalog search path
CREATE FUNCTION public.stella_database_pressure_cache_publish(instance text, token text, reading jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF jsonb_typeof(reading) <> 'object' OR pg_column_size(reading) > 4096 THEN
    RAISE EXCEPTION 'Invalid pressure snapshot' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.database_pressure_cache SET snapshot = reading, refresh_token = NULL
  WHERE instance_identifier = instance AND refresh_token = token;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_database_pressure_cache_publish(text, text, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_database_pressure_cache_publish(text, text, jsonb) TO stella_ingestion;
