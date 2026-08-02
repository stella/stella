SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The corpus generation checkpoint takes `LOCK TABLE case_law_decisions,
-- case_law_sources IN SHARE MODE` to hold out writers while it captures the
-- snapshot clock. PostgreSQL admits that lock mode only for a role holding
-- table-level UPDATE, DELETE, TRUNCATE, or MAINTAIN; a column-scoped UPDATE
-- does not satisfy the check, and case_law_sources is granted column-scoped
-- UPDATE only, so the role cannot take the lock it needs.
-- MAINTAIN is the narrowest privilege that admits the lock: it confers no
-- whole-row write, so the column scope on this table is preserved.
GRANT MAINTAIN ON TABLE "case_law_sources" TO stella_ingestion;--> statement-breakpoint
