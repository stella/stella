-- SET LOCAL, not SET: the migrator runs every pending migration on one
-- connection inside one transaction, so a session-level setting here would
-- outlive this file and silently govern whatever runs after it.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Citation resolution recorded its outcome in the nullability of
-- "cited_decision_id", which cannot distinguish "not examined yet" from
-- "examined, and no honest link exists". The resolver's scan predicate
-- therefore never emptied: every citation whose key names a decision nobody
-- holds was re-examined on every pass, forever, and the partial index that
-- was meant to burn down stayed the size of that permanent residue.
--
-- The outcome moves to its own column. Four values, because "no candidate"
-- and "more than one candidate" have different repairs: a decision published
-- later fixes the first, a deterministic context cue fixes the second.
--
-- Split across three migrations because their timeout needs differ: this one
-- is fast DDL under bounded locks, 20260816121000 is the long scans, and
-- 20260816122000 is the concurrent index builds.
ALTER TABLE "case_law_citations"
  ADD COLUMN IF NOT EXISTS "resolution_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "case_law_citations"
  ADD COLUMN IF NOT EXISTS "resolution_attempted_at" timestamptz;--> statement-breakpoint

-- NOT VALID here, VALIDATE in 20260816121000: adding a validating CHECK scans
-- every row while holding ACCESS EXCLUSIVE, which on a table this size is an
-- outage. NOT VALID takes the lock only long enough to record the constraint;
-- the scan then runs under SHARE UPDATE EXCLUSIVE, which concurrent readers
-- and writers do not wait on.
ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_resolution_status_values"
  CHECK ("resolution_status" IN ('pending','resolved','unmatched','ambiguous'))
  NOT VALID;--> statement-breakpoint

-- The empty string is not a key, it is the absence of one wearing a value's
-- clothes. Two rows that both failed to canonicalize would carry the same
-- "key" and join each other, drawing an edge between unrelated cases; null
-- already means "no key", so this makes the second spelling unrepresentable.
-- One writer wrote '' where the other wrote NULL, which is exactly the drift
-- a constraint exists to stop.
ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_citation_key_non_empty"
  CHECK ("citation_key" <> '')
  NOT VALID;--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD CONSTRAINT "decisions_citation_key_non_empty"
  CHECK ("citation_key" <> '')
  NOT VALID;--> statement-breakpoint

-- Where the standing resolution walk had got to. The walk is correct without
-- it — settled rows leave the pending predicate, so a restart from the
-- beginning loses no work — but the left edge of the burn-down index carries
-- index entries autovacuum has not reclaimed yet, and every restart would
-- re-read them before reaching live work.
CREATE TABLE IF NOT EXISTS "case_law_citation_resolution_progress" (
  "scope" text PRIMARY KEY NOT NULL,
  "cursor_citing_decision_id" uuid,
  "cursor_citation_id" uuid,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Added validating, not NOT VALID + VALIDATE: the table is created empty in
-- this same migration, so the scan is over no rows.
ALTER TABLE "case_law_citation_resolution_progress"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_progress_scope_values"
  CHECK ("scope" IN ('global'));--> statement-breakpoint

-- Half a keyset is not a position: either both columns name where the walk
-- stopped, or neither does and it starts from the beginning.
ALTER TABLE "case_law_citation_resolution_progress"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_progress_cursor_pair"
  CHECK (("cursor_citing_decision_id" IS NULL) = ("cursor_citation_id" IS NULL));--> statement-breakpoint

ALTER TABLE "case_law_citation_resolution_progress"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Same access shape as the coverage ledger and the reconciliation items: the
-- app role reads it for the ingestion status rollup, only ingestion writes it.
CREATE POLICY "case_law_global_access" ON "case_law_citation_resolution_progress" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_citation_resolution_progress" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs — both are needed.
GRANT SELECT ON TABLE "case_law_citation_resolution_progress" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_citation_resolution_progress" TO stella_ingestion;
