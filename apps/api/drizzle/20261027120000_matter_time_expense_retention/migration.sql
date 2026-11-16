SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- Lock review: each atomic swap takes ACCESS EXCLUSIVE for catalog-only DDL,
-- waits at most one second, and does not scan or rewrite time entry or
-- expense rows. Keep validation in the online phase so these locks are
-- released first.
-- stella-migration-safety: reviewed drop-constraint - Replace both time-entry-to-matter cascades atomically with restrictive NOT VALID foreign keys; existing rows are untouched and new writes remain checked.
ALTER TABLE "time_entries"
  DROP CONSTRAINT "time_entries_workspace_id_workspaces_id_fkey",
  DROP CONSTRAINT "time_entries_workspace_organization_fk",
  ADD CONSTRAINT "time_entries_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE NO ACTION NOT VALID,
  ADD CONSTRAINT "time_entries_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE NO ACTION NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replace both expense-to-matter cascades atomically; retaining the matter reference keeps every unbilled expense and its amount.
ALTER TABLE "expenses"
  DROP CONSTRAINT "expenses_workspace_id_workspaces_id_fkey",
  DROP CONSTRAINT "expenses_workspace_organization_fk",
  ADD CONSTRAINT "expenses_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE NO ACTION NOT VALID,
  ADD CONSTRAINT "expenses_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE NO ACTION NOT VALID;
