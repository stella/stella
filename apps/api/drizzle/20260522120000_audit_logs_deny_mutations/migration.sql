-- Audit logs are append-only. The `audit_logs_select` / `audit_logs_insert`
-- policies are the only access `stella` has; UPDATE and DELETE are denied
-- today purely by Postgres' default-deny (no matching policy).
--
-- These RESTRICTIVE policies make that immutability explicit and durable.
-- A RESTRICTIVE `USING (false)` is AND-ed into every permissive policy, so
-- a future migration that adds a permissive UPDATE/DELETE policy cannot
-- silently unlock mutation of the audit trail.

CREATE POLICY "audit_logs_no_update" ON "audit_logs"
  AS RESTRICTIVE FOR UPDATE TO "stella"
  USING (false);

CREATE POLICY "audit_logs_no_delete" ON "audit_logs"
  AS RESTRICTIVE FOR DELETE TO "stella"
  USING (false);
