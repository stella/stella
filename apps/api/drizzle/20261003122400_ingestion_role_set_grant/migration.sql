-- requires: 20260516000000_case_law_ingestion_role
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

DO $$
BEGIN
  IF CURRENT_USER <> 'stella_ingestion'
     AND NOT pg_has_role(CURRENT_USER, 'stella_ingestion', 'SET') THEN
    EXECUTE format('GRANT stella_ingestion TO %I WITH SET TRUE', CURRENT_USER);
  END IF;
END $$;
