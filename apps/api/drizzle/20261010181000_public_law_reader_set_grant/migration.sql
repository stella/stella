-- requires: 20260823190000_public_law_reader_role
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The application owner assumes the existing column-restricted reader;
-- the creator ADMIN grant alone does not permit SET ROLE on PostgreSQL 16+.
DO $$
BEGIN
  IF CURRENT_USER <> 'stella_public_law_reader'
     AND NOT pg_has_role(CURRENT_USER, 'stella_public_law_reader', 'SET') THEN
    EXECUTE format('GRANT stella_public_law_reader TO %I WITH SET TRUE, INHERIT FALSE', CURRENT_USER);
  END IF;
END $$;
