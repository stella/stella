-- requires: 20260823190000_public_law_reader_role
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The application owner assumes the existing column-restricted reader;
-- the creator ADMIN grant alone does not permit SET ROLE on PostgreSQL 16+.
-- stella-migration-safety: reviewed grant-privileges - Only the migration owner can assume the existing column-restricted reader; its privileges are not inherited.
GRANT stella_public_law_reader TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
