SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The exclusive side of the projection mutation fence never waits unbounded.
-- A queued exclusive request holds every later writer behind it, so a caller
-- that left lock_timeout unset (0) waits at most two seconds and then gets
-- lock_not_available (55P03); a caller that set its own lock_timeout keeps
-- it. The bound applies to the wait only: the caller's setting is back in
-- place when the function returns, and a failed wait rolls back with the
-- (sub)transaction it happened in, setting included. Owner, grants, search
-- path and SECURITY INVOKER are unchanged.
CREATE OR REPLACE FUNCTION "lock_corpus_projection_mutations_exclusive"()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller_lock_timeout text := pg_catalog.current_setting('lock_timeout');
BEGIN
  IF caller_lock_timeout <> '0' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(1937007986, 1);
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(1937007986, 1);
  PERFORM pg_catalog.set_config('lock_timeout', caller_lock_timeout, true);
END;
$$;
