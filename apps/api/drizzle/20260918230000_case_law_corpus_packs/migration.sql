SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- One ingestion batch writes one pack, so the three addresses an intent
-- reserves are members of a shared object rather than three objects of their
-- own. The pack a reservation belongs to is what cleanup has to ask about,
-- and it cannot be read out of the address columns without a pattern scan.
-- Null for a reservation that names standalone objects.
--
-- Every statement in this migration is re-runnable: the concurrent index at
-- the end commits the transaction, so a build cancelled there leaves this
-- file to be applied again from the top.
ALTER TABLE "case_law_corpus_upload_intents"
  ADD COLUMN IF NOT EXISTS "pack_key" varchar(512);--> statement-breakpoint

-- Which pack each stored pointer addresses, written in the transaction that
-- writes the pointer. Cleanup asks "is this pack still referenced?" as an
-- equality lookup here instead of a prefix match over the decisions table:
-- that table carries no index on its pointer columns, which is what keeps a
-- pointer rewrite from touching any index at all.
--
-- No foreign key, for the same reason the upload intents carry none: the
-- ownership record must outlive a decision row that is being erased.
CREATE TABLE IF NOT EXISTS "case_law_corpus_pack_refs" (
  "decision_id" uuid NOT NULL,
  "kind" varchar(16) NOT NULL,
  "pack_key" varchar(512) NOT NULL,
  "location" varchar(512) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_corpus_pack_refs_pk" PRIMARY KEY ("decision_id", "kind"),
  -- Derived from PACK_MEMBER_KINDS; a kind a pack can hold and this check
  -- rejects is what the two being written apart would produce.
  CONSTRAINT "case_law_corpus_pack_refs_kind_values"
    CHECK ("kind" IN ('text', 'sections', 'ast'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "case_law_corpus_pack_refs_pack_idx"
  ON "case_law_corpus_pack_refs" ("pack_key");--> statement-breakpoint

-- Locations a reader must refuse whatever the object behind them still holds.
--
-- A standalone corpus object is erased by deleting it. A member of a pack
-- cannot be: the pack carries other decisions' payloads. The erasure records
-- the member's address here instead, and every corpus read consults this
-- table before it fetches a range, so erased bytes stop being readable at the
-- moment of the erasure. The pack key travels with the address because the
-- bytes are still inside that object until it is rewritten, and the rewrite
-- has to be able to list what it owes.
--
-- Only an erasure writes here. An upload that never landed is reclaimed by
-- deleting what it wrote; denying its addresses would deny the retry that
-- re-derives them.
--
-- Readable by every reader role: refusing to serve is not a privileged
-- decision, and a reader that cannot see the tombstone would serve the bytes.
CREATE TABLE IF NOT EXISTS "case_law_corpus_tombstones" (
  "location" varchar(512) PRIMARY KEY NOT NULL,
  "pack_key" varchar(512) NOT NULL,
  "decision_id" uuid NOT NULL,
  "reason" varchar(32) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  -- Derived from CASE_LAW_CORPUS_TOMBSTONE_REASONS.
  CONSTRAINT "case_law_corpus_tombstones_reason_values"
    CHECK ("reason" IN ('redaction', 'withdrawal'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "case_law_corpus_tombstones_decision_idx"
  ON "case_law_corpus_tombstones" ("decision_id");--> statement-breakpoint

-- The packs that owe a rewrite, as a listing rather than a scan of addresses.
CREATE INDEX IF NOT EXISTS "case_law_corpus_tombstones_pack_idx"
  ON "case_law_corpus_tombstones" ("pack_key");--> statement-breakpoint

ALTER TABLE "case_law_corpus_pack_refs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates with the same name and rule, so a re-applied
-- migration re-enters the same state; rollback is dropping the table.
DROP POLICY IF EXISTS "case_law_ingestion_access"
  ON "case_law_corpus_pack_refs";--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_corpus_pack_refs"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint

ALTER TABLE "case_law_corpus_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates with the same name and rule, so a re-applied
-- migration re-enters the same state; rollback is dropping the table.
DROP POLICY IF EXISTS "case_law_ingestion_access"
  ON "case_law_corpus_tombstones";--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_corpus_tombstones"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates with the same name and rule, so a re-applied
-- migration re-enters the same state; rollback is dropping the table.
DROP POLICY IF EXISTS "case_law_global_access"
  ON "case_law_corpus_tombstones";--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "case_law_corpus_tombstones"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates with the same name and rule, so a re-applied
-- migration re-enters the same state; rollback is dropping the table.
DROP POLICY IF EXISTS "public_law_reader_access"
  ON "case_law_corpus_tombstones";--> statement-breakpoint
CREATE POLICY "public_law_reader_access"
  ON "case_law_corpus_tombstones"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader
  USING (true);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_pack_refs" TO stella_ingestion;--> statement-breakpoint
-- Ingestion bookkeeping: the request role reads corpus payloads, never which
-- decision owns which member of a pack.
REVOKE ALL PRIVILEGES ON TABLE "case_law_corpus_pack_refs" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_tombstones" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_tombstones" TO stella;--> statement-breakpoint
-- Exactly the column a read consults: the address it is about to fetch.
-- Who was erased, why, and which pack owes the rewrite stay on the owning
-- service side.
GRANT SELECT (location) ON TABLE "case_law_corpus_tombstones"
  TO stella_public_law_reader;--> statement-breakpoint
-- The analysis writer reads parses out of the corpus, so it asks the same
-- question of the same column before it fetches a packed member.
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates with the same name and rule, so a re-applied
-- migration re-enters the same state; rollback is dropping the table.
DROP POLICY IF EXISTS "case_law_analysis_writer_read"
  ON "case_law_corpus_tombstones";--> statement-breakpoint
CREATE POLICY "case_law_analysis_writer_read"
  ON "case_law_corpus_tombstones"
  AS PERMISSIVE FOR SELECT TO stella_case_law_analysis_writer
  USING (true);--> statement-breakpoint
GRANT SELECT (location) ON TABLE "case_law_corpus_tombstones"
  TO stella_case_law_analysis_writer;--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build,
-- then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- Retry cleanup for this migration's own index: a cancelled concurrent build
-- can leave an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_corpus_upload_intents_pack_idx";
--> statement-breakpoint
-- The cleanup liveness question, as an equality lookup on the reservations
-- that still claim a pack.
--
-- The DROP above is what makes this re-runnable. `IF NOT EXISTS` would read
-- as robust and is not: it would adopt an INVALID index a cancelled build
-- left behind, which is why migration-concurrent-index.test.ts admits that
-- spelling only for indexes with an online validity postcondition.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_corpus_upload_intents_pack_idx"
  ON "case_law_corpus_upload_intents" ("pack_key");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
