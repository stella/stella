SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Validate outside the ADD transaction so the table scan does not inherit its
-- ACCESS EXCLUSIVE lock. Parties rows are one per document version and the
-- table is young; the timeout keeps that assumption explicit.
ALTER TABLE "document_review_parties"
  VALIDATE CONSTRAINT "document_review_parties_workspace_id_workspaces_id_fk";
