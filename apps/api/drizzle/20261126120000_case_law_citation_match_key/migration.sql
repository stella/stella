SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The match key of a citation's effective identifier (its normalized
-- identifier, or its citation key on rows written before identifiers): the
-- value `caseNumberMatchKey` folds it to. Stored so a lookup by an arriving
-- identifier is a plain index probe rather than a fold of every candidate.
-- Nullable with no default, so adding it rewrites no stored row; the trigger
-- below owns every later value, and the online repair
-- `citation-identifier-match-key` writes the rows stored before it.
ALTER TABLE "case_law_citations" ADD COLUMN "identifier_match_key" varchar(256);--> statement-breakpoint

-- The fold is `caseNumberMatchKeySql` in
-- src/lib/case-law/case-number-match-key.ts, spelled as its renderer spells it;
-- `citation-identifier-match-key.db.test.ts` holds this body to that rendering
-- and its output to `caseNumberMatchKey`. It fires on every write that names
-- either input or the key itself, so a writer cannot store a key that differs
-- from the fold of the row's own values.
CREATE FUNCTION case_law_citations_identifier_match_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  NEW.identifier_match_key := regexp_replace(coalesce(NEW.normalized_identifier_value, NEW.citation_key), '/(?:19|20)([0-9]{2})(-[0-9]+)?$', '/\1\2');
  RETURN NEW;
END
$function$;--> statement-breakpoint

CREATE TRIGGER case_law_citations_identifier_match_key
BEFORE INSERT OR UPDATE OF citation_key, normalized_identifier_value, identifier_match_key ON "case_law_citations"
FOR EACH ROW
EXECUTE FUNCTION case_law_citations_identifier_match_key();--> statement-breakpoint

-- Identifiers a decision write stored, waiting for the citation graph to
-- reopen the citations they can answer differently. The write enqueues them in
-- its own transaction and a drain consumes them in another, so an arrival is
-- never lost between the two: a drain that does not commit leaves its rows for
-- the next. The key is already folded (`caseNumberMatchKey`). Written by
-- ingestion only; a deleted decision takes its arrivals with it.
CREATE TABLE "case_law_citation_arrivals" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "decision_id" uuid NOT NULL,
  "identifier_type" varchar(32) NOT NULL,
  "match_key" varchar(256) NOT NULL,
  "jurisdiction" varchar(3) NOT NULL,
  "decision_date" date,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_citation_arrivals_decision_id_fk"
    FOREIGN KEY ("decision_id") REFERENCES "case_law_decisions"("id") ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX "case_law_citation_arrivals_decision_idx"
  ON "case_law_citation_arrivals" ("decision_id");--> statement-breakpoint

ALTER TABLE "case_law_citation_arrivals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_citation_arrivals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_citation_arrivals"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_citation_arrivals" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_citation_arrivals" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_citation_arrivals" TO stella_ingestion;--> statement-breakpoint

-- The stored-key index and the index of rows still waiting for a key are
-- built concurrently after deploy by their online migration entries in
-- src/db/online-migration-entries/.
