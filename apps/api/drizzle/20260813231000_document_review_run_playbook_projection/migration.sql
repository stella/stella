SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A nullable query projection records which playbook definition opened a
-- review run. The pinned basis remains the source of historical truth; this
-- column has no foreign key so deleting a playbook cannot alter review history.
ALTER TABLE "document_review_runs"
  ADD COLUMN "playbook_definition_id" uuid;
