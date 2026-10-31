SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The physical corpus-index id of a case-law decision, derived in one place.
--
-- CZE moves to an index group of its own from generation `case_law_v9` on. The
-- generations before it keep `cs_sk`, so every id, projection fingerprint and
-- manifest digest they carry is unchanged; v9 is a partial generation built
-- beside the serving one, and a jurisdiction is switched to it only by the
-- gated flip (corpus_index_jurisdiction_serving below), never by this
-- migration. Everything else in the body is as
-- 20260927200100_case_law_corpus_index_groups_usa left it.
--
-- Up to generation `case_law_v2` the id is `<generation>_<country>`, one
-- index per jurisdiction. From `case_law_v3` on it is `<generation>_<group>`,
-- where the group is the jurisdiction's entry in `CASE_LAW_INDEX_GROUP_OF`
-- (apps/api/src/lib/legal-search/case-law-index-groups.ts), or in
-- `CASE_LAW_INDEX_GROUP_REHOMES` from the generation the rehome starts at.
--
-- IMMUTABLE and STRICT: the result depends on its two arguments alone, and a
-- NULL argument yields NULL, the same as the concatenation it replaces.
CREATE OR REPLACE FUNCTION case_law_corpus_index_id(generation text, country text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT
AS $function$
  SELECT CASE
  WHEN substring(generation from '^case_law_v([1-9][0-9]*)$')::numeric
       BETWEEN 3
       AND 2147483647
  THEN generation || '_' || CASE upper(country)
    WHEN 'AUT' THEN 'aut'
    WHEN 'CZE' THEN CASE WHEN substring(generation from '^case_law_v([1-9][0-9]*)$')::numeric >= 9 THEN 'cze' ELSE 'cs_sk' END
    WHEN 'EU' THEN 'eu'
    WHEN 'HUN' THEN 'hun'
    WHEN 'POL' THEN 'pol'
    WHEN 'SVK' THEN 'cs_sk'
    WHEN 'USA' THEN 'usa'
    ELSE lower(country)
  END
  ELSE generation || '_' || lower(country)
END
$function$;--> statement-breakpoint

-- The group contract an enrollment may record gains `provision_keys_v1`. The
-- registry holds a handful of rows, so the replacement validates at once.
-- stella-migration-safety: reviewed drop-constraint - Recreates the same check in the next statement of this transaction with one more allowed value, so every existing row stays valid and no write sees the table unconstrained; running API tasks never write provision_keys_v1, and a rollback restores the narrower check once no row records it.
ALTER TABLE "corpus_index_group_enrollments"
  DROP CONSTRAINT IF EXISTS "corpus_index_group_enrollments_contract_values";--> statement-breakpoint
ALTER TABLE "corpus_index_group_enrollments"
  ADD CONSTRAINT "corpus_index_group_enrollments_contract_values"
    CHECK ("contract_version" IN ('base','court_partition_v1','provision_keys_v1'))
    NOT VALID;--> statement-breakpoint

-- Release the schema lock before validation scans the existing rows.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- Added NOT VALID in the committed transaction above; validation holds no earlier schema lock.
ALTER TABLE "corpus_index_group_enrollments"
  VALIDATE CONSTRAINT "corpus_index_group_enrollments_contract_values";--> statement-breakpoint

-- The generation that serves a jurisdiction when it is not the family's
-- serving generation. Created empty: without a row a jurisdiction is served by
-- the family's serving generation, which is today's routing for every
-- jurisdiction, so nothing is flipped here. A row is written only by the gated
-- flip (apps/api/src/lib/legal-search/case-law-serving-flip.ts), and deleted
-- when a whole generation is promoted.
CREATE TABLE "corpus_index_jurisdiction_serving" (
  "family" text NOT NULL,
  "jurisdiction" varchar(3) NOT NULL,
  "generation" varchar(32) NOT NULL,
  "from_generation" varchar(32) NOT NULL,
  "flipped_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "corpus_index_jurisdiction_serving_pkey"
    PRIMARY KEY ("family", "jurisdiction"),
  CONSTRAINT "corpus_index_jurisdiction_serving_generation_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "public"."corpus_index_generations"("family", "generation")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "corpus_index_jurisdiction_serving_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_jurisdiction_serving_jurisdiction_shape"
    CHECK ("jurisdiction" ~ '^[A-Z]{2,3}$')
);--> statement-breakpoint

ALTER TABLE "corpus_index_jurisdiction_serving" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_jurisdiction_serving" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "corpus_index_jurisdiction_serving_owner_access"
  ON "corpus_index_jurisdiction_serving" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_jurisdiction_serving'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_jurisdiction_serving'::regclass));--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_jurisdiction_serving"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_jurisdiction_serving"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access"
  ON "corpus_index_jurisdiction_serving"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader
  USING (true);--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE "corpus_index_jurisdiction_serving" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "corpus_index_jurisdiction_serving" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "corpus_index_jurisdiction_serving"
  TO stella_ingestion;--> statement-breakpoint
GRANT UPDATE ("generation", "from_generation", "flipped_at")
  ON TABLE "corpus_index_jurisdiction_serving" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ("family", "jurisdiction", "generation")
  ON TABLE "corpus_index_jurisdiction_serving" TO stella_public_law_reader;
