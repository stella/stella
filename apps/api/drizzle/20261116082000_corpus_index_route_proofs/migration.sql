SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The readiness proof of one physical index (route) of a corpus generation:
-- the census pass walking it, and the last clean pass, bound to the engine
-- incarnation of the index it started and ended on. Ordinary projection
-- writes never touch it, since every move into applied, settled or withdrawn
-- carries its own engine observation. A census drift repair, another engine
-- incarnation, and an attestation withdrawn or given anew revoke it, each in
-- the transaction of that change. A generation's rebuild deletes its
-- registration, and the cascade deletes its proofs with it.
CREATE TABLE IF NOT EXISTS "corpus_index_route_proofs" (
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "index_id" varchar(64) NOT NULL,
  "pass_number" bigint DEFAULT 1 NOT NULL,
  "pass_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "pass_started_at" timestamptz NOT NULL,
  "pass_through" uuid,
  "pass_expectation" text NOT NULL,
  "pass_cursor" uuid,
  "pass_inspected" bigint DEFAULT 0 NOT NULL,
  "pass_index_incarnation" varchar(160),
  "proven_pass_number" bigint,
  "proven_pass_started_at" timestamptz,
  "proven_at" timestamptz,
  "proven_inspected" bigint,
  "proven_index_incarnation" varchar(160),
  "revoked_at" timestamptz,
  "revoked_pass_number" bigint,
  "revoke_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_route_proofs_pkey"
    PRIMARY KEY ("family", "generation", "index_id"),
  -- Declared with the table, which is created empty: nothing to validate.
  -- The referenced registry holds a handful of rows.
  CONSTRAINT "corpus_index_route_proofs_generation_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "public"."corpus_index_generations"("family", "generation")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "corpus_index_route_proofs_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_route_proofs_index_shape"
    CHECK ("index_id" ~ '^[a-z0-9_]+$'),
  CONSTRAINT "corpus_index_route_proofs_expectation_values"
    CHECK ("pass_expectation" IN ('present','absent')),
  CONSTRAINT "corpus_index_route_proofs_inspected_nonnegative"
    CHECK ("pass_number" > 0 AND "pass_inspected" >= 0 AND ("proven_inspected" IS NULL OR "proven_inspected" >= 0)),
  CONSTRAINT "corpus_index_route_proofs_proven_shape"
    CHECK (("proven_at" IS NULL) = ("proven_pass_started_at" IS NULL)
      AND ("proven_at" IS NULL) = ("proven_inspected" IS NULL)
      AND ("proven_at" IS NULL) = ("proven_pass_number" IS NULL)
      AND ("proven_at" IS NULL) = ("proven_index_incarnation" IS NULL)
      AND ("proven_pass_number" IS NULL OR "proven_pass_number" < "pass_number")
      AND ("proven_at" IS NULL OR "proven_at" >= "proven_pass_started_at")),
  CONSTRAINT "corpus_index_route_proofs_revoke_shape"
    CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)
      AND ("revoked_at" IS NULL) = ("revoked_pass_number" IS NULL)
      AND ("revoked_pass_number" IS NULL OR "revoked_pass_number" <= "pass_number")
      AND ("revoke_reason" IS NULL OR "revoke_reason" IN ('present_drift','absent_drift','index_replaced','group_withdrawn','group_attested')))
);--> statement-breakpoint

ALTER TABLE "corpus_index_route_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_route_proofs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- FORCE RLS also binds the owner-run projection transactions, so the owner
-- gets its own policy; grants decide what every other role may do.
CREATE POLICY "corpus_index_route_proofs_owner_access"
  ON "corpus_index_route_proofs" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_route_proofs'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_route_proofs'::regclass));--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_route_proofs"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_route_proofs"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint

-- The projection runner advances and revokes proofs; nothing deletes one but
-- the generation's cascade.
REVOKE ALL PRIVILEGES ON TABLE "corpus_index_route_proofs" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "corpus_index_route_proofs" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "corpus_index_route_proofs"
  TO stella_ingestion;
