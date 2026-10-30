SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- What each consolidation changed against the eligible consolidation before it
-- (provisions changed, added and removed; words inserted and deleted), with
-- the payload revisions it was computed from. Derived state: ingestion writes
-- it after storing a version, and the `legislation-version-changes` backfill
-- fills the rows stored before. Nullable and without a default, so adding it
-- rewrites no row and every existing row reads as not yet computed.
ALTER TABLE "legislation_documents" ADD COLUMN IF NOT EXISTS "change_summary" jsonb;--> statement-breakpoint

-- Column grants are enumerated, so a new column is unreadable by the public
-- reader until it is named. The versions list serves a summary only while the
-- row's payload revision is the one it was computed from, so the reader needs
-- that counter too; it is a plain integer and names nothing.
GRANT SELECT ("change_summary", "payload_revision")
  ON TABLE "legislation_documents"
  TO stella_public_law_reader;
