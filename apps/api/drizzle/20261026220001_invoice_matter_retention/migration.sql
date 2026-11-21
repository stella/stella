SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- Lock review: each atomic swap takes ACCESS EXCLUSIVE for catalog-only DDL,
-- waits at most one second, and does not scan or rewrite invoice rows. Keep
-- validation in the online phase so these locks are released first.
-- stella-migration-safety: reviewed drop-constraint - Replace both matter cascades atomically with restrictive NOT VALID foreign keys; existing rows are untouched and new writes remain checked.
ALTER TABLE "invoices"
  DROP CONSTRAINT "invoices_workspace_id_workspaces_id_fkey",
  DROP CONSTRAINT "invoices_workspace_organization_fk",
  ADD CONSTRAINT "invoices_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE NO ACTION NOT VALID,
  ADD CONSTRAINT "invoices_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE NO ACTION NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replace both line-to-matter cascades atomically; retaining the matter reference preserves line identity and all stored billing snapshots.
ALTER TABLE "invoice_lines"
  DROP CONSTRAINT "invoice_lines_workspace_id_workspaces_id_fk",
  DROP CONSTRAINT "invoice_lines_workspace_organization_fk",
  ADD CONSTRAINT "invoice_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE NO ACTION NOT VALID,
  ADD CONSTRAINT "invoice_lines_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE NO ACTION NOT VALID;
