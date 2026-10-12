SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Preserve the owner-only fence while evaluating its statement-constant predicate once. Rollback restores the equivalent comparison outside the subquery.
ALTER POLICY case_law_replay_batches_owner_access ON case_law_replay_batches
  USING ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_batches'::regclass))
  WITH CHECK ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_batches'::regclass));
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Preserve the owner-only fence while evaluating its statement-constant predicate once. Rollback restores the equivalent comparison outside the subquery.
ALTER POLICY case_law_replay_blocked_owner_access ON case_law_replay_blocked
  USING ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_blocked'::regclass))
  WITH CHECK ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_blocked'::regclass));
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Preserve the owner-only fence while evaluating its statement-constant predicate once. Rollback restores the equivalent comparison outside the subquery.
ALTER POLICY case_law_replay_daily_rows_owner_access ON case_law_replay_daily_rows
  USING ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_daily_rows'::regclass))
  WITH CHECK ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_daily_rows'::regclass));
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Preserve the owner-only fence while evaluating its statement-constant predicate once. Rollback restores the equivalent comparison outside the subquery.
ALTER POLICY case_law_replay_source_progress_owner_access ON case_law_replay_source_progress
  USING ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_source_progress'::regclass))
  WITH CHECK ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_source_progress'::regclass));
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Preserve the owner-only fence while evaluating its statement-constant predicate once. Rollback restores the equivalent comparison outside the subquery.
ALTER POLICY case_law_replay_audit_events_owner_access ON case_law_replay_audit_events
  USING ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_audit_events'::regclass))
  WITH CHECK ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_audit_events'::regclass));
