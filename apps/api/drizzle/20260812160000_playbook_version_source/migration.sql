SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A version snapshot now names why it was written. A review run pins "the
-- playbook's latest approved version", which until now was read as "the newest
-- row" — sound only while approval is the only thing that writes one. A
-- snapshot taken for another reason (an import, a restore, an autosave) would
-- silently have become the standard a document was judged against.
--
-- Every existing row is an approval (`approve.ts` is the only writer to date),
-- so the column lands with that as a transient default and then drops it: a new
-- writer must state its source rather than inherit one.
ALTER TABLE "playbook_definition_versions"
  ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'approval' NOT NULL;--> statement-breakpoint

ALTER TABLE "playbook_definition_versions"
  ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint

-- Added validating rather than NOT VALID + VALIDATE. The table holds one row
-- per playbook approval, bounded per playbook by the version-history cap, so
-- the scan is trivial; and the migrator wraps a migration in one transaction,
-- so the split form would hold its locks to commit anyway.
ALTER TABLE "playbook_definition_versions"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "playbook_def_versions_source_values_check"
  CHECK ("source" IN ('approval'));
