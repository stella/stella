SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- One index group of a corpus generation bound to the group contract its
-- physical index is created under (corpus-index-group-contract.ts). Only a
-- group whose contract is not the generation manifest's own is enrolled; every
-- other group keeps the attestation its generation already has, and no
-- existing generation row changes.
--
-- The binding columns are written once: the ingestion role may insert a row
-- and may move only its readiness (`provisioning_status`, `attested_at`,
-- `updated_at`), so a bound effective digest cannot be overwritten. A
-- generation's rebuild deletes its registration, and the cascade deletes its
-- enrollments with it, because a rebuilt generation's indexes are attested
-- again.
CREATE TABLE IF NOT EXISTS "corpus_index_group_enrollments" (
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "index_group" varchar(32) NOT NULL,
  "physical_index_id" varchar(64) NOT NULL,
  "contract_version" text NOT NULL,
  "effective_digest" varchar(64) NOT NULL,
  "provisioning_status" text NOT NULL,
  "attested_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_group_enrollments_pkey"
    PRIMARY KEY ("family", "generation", "index_group"),
  -- Declared with the table, which is created empty: nothing to validate.
  -- The referenced registry holds a handful of rows.
  CONSTRAINT "corpus_index_group_enrollments_generation_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "public"."corpus_index_generations"("family", "generation")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "corpus_index_group_enrollments_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_group_enrollments_contract_values"
    CHECK ("contract_version" IN ('court_partition_v1')),
  CONSTRAINT "corpus_index_group_enrollments_status_values"
    CHECK ("provisioning_status" IN ('pending','attested')),
  CONSTRAINT "corpus_index_group_enrollments_digest_shape"
    CHECK ("effective_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "corpus_index_group_enrollments_index_of_generation"
    CHECK ("physical_index_id" = "generation" || '_' || "index_group"),
  CONSTRAINT "corpus_index_group_enrollments_attested_at"
    CHECK (("provisioning_status" = 'attested') = ("attested_at" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "corpus_index_group_enrollments"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_group_enrollments"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_group_enrollments"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access"
  ON "corpus_index_group_enrollments"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader
  USING (true);--> statement-breakpoint

GRANT SELECT ON TABLE "corpus_index_group_enrollments" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "corpus_index_group_enrollments"
  TO stella_ingestion;--> statement-breakpoint
GRANT UPDATE ("provisioning_status", "attested_at", "updated_at")
  ON TABLE "corpus_index_group_enrollments" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ("family", "generation", "index_group", "effective_digest", "provisioning_status")
  ON TABLE "corpus_index_group_enrollments" TO stella_public_law_reader;
