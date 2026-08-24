SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Constant-size source of truth for the jurisdiction indexes a corpus
-- generation must hold. The case-law table has millions of rows and only a
-- handful of countries; SELECT DISTINCT nevertheless plans as a full parallel
-- scan in production. This registry is derived at the write boundary instead.
CREATE TABLE "case_law_corpus_jurisdictions" (
  "country" varchar(3) NOT NULL,
  "first_observed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_corpus_jurisdictions_pkey" PRIMARY KEY ("country")
);--> statement-breakpoint

ALTER TABLE "case_law_corpus_jurisdictions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_corpus_jurisdictions"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "case_law_corpus_jurisdictions"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_jurisdictions" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "case_law_corpus_jurisdictions" TO stella_ingestion;--> statement-breakpoint

-- Inserts are normally batched, so register their distinct countries once per
-- statement. Country corrections are rare and use a row trigger whose WHEN
-- clause prevents unrelated decision updates from paying registry work.
CREATE FUNCTION register_inserted_case_law_corpus_jurisdictions()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO case_law_corpus_jurisdictions (country)
  SELECT DISTINCT country
  FROM inserted_decisions
  ON CONFLICT ON CONSTRAINT case_law_corpus_jurisdictions_pkey DO NOTHING;
  RETURN NULL;
END
$function$;--> statement-breakpoint

CREATE FUNCTION register_updated_case_law_corpus_jurisdiction()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO case_law_corpus_jurisdictions (country)
  VALUES (NEW.country)
  ON CONFLICT ON CONSTRAINT case_law_corpus_jurisdictions_pkey DO NOTHING;
  RETURN NULL;
END
$function$;--> statement-breakpoint

-- Install the derivation before the seed. CREATE TRIGGER's table lock closes
-- the gap in which a concurrent decision could otherwise commit after the
-- seed's snapshot but before future writes were observed.
CREATE TRIGGER case_law_corpus_jurisdictions_insert
AFTER INSERT ON "case_law_decisions"
REFERENCING NEW TABLE AS inserted_decisions
FOR EACH STATEMENT
EXECUTE FUNCTION register_inserted_case_law_corpus_jurisdictions();--> statement-breakpoint

CREATE TRIGGER case_law_corpus_jurisdictions_country_update
AFTER UPDATE OF "country" ON "case_law_decisions"
FOR EACH ROW
WHEN (OLD.country IS DISTINCT FROM NEW.country)
EXECUTE FUNCTION register_updated_case_law_corpus_jurisdiction();--> statement-breakpoint

-- PostgreSQL otherwise chooses a sequential aggregate over the whole corpus.
-- This loose index scan performs one case_law_decisions_country_idx seek per
-- distinct country, so the additive migration remains bounded at corpus scale.
-- stella-migration-safety: reviewed bulk-backfill - the loose index scan performs one indexed min(country) seek per distinct three-letter jurisdiction rather than scanning case_law_decisions; it inserts at most the bounded jurisdiction-code domain into a new empty registry and is idempotent.
WITH RECURSIVE observed_countries(country) AS (
  SELECT min(country)
  FROM case_law_decisions
  UNION ALL
  SELECT (
    SELECT min(decision.country)
    FROM case_law_decisions AS decision
    WHERE decision.country > observed_countries.country
  )
  FROM observed_countries
  WHERE observed_countries.country IS NOT NULL
)
INSERT INTO case_law_corpus_jurisdictions (country)
SELECT country
FROM observed_countries
WHERE country IS NOT NULL
ON CONFLICT ON CONSTRAINT case_law_corpus_jurisdictions_pkey DO NOTHING;
