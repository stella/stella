-- requires: 20261116163500_corpus_index_route_proofs
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The receipt of every whole-family serving flip: who made it, when, which
-- pair, and the evidence the guarded flip read (parity verdict, route proofs,
-- seeding passes, engine counts) with its digest. The flip writes it in its
-- own transaction, so a flip and its receipt commit together. Append-only.
-- No foreign key: a receipt outlives a generation's rebuild, which deletes
-- the registry row it names.
CREATE TABLE IF NOT EXISTS "corpus_index_generation_flips" (
  "id" uuid PRIMARY KEY NOT NULL,
  "family" text NOT NULL,
  "from_generation" varchar(32),
  "to_generation" varchar(32) NOT NULL,
  "actor" varchar(128) NOT NULL,
  "reason" varchar(2048) NOT NULL,
  "evidence" jsonb NOT NULL,
  "evidence_digest" varchar(64) NOT NULL,
  "flipped_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_generation_flips_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_generation_flips_actor_shape"
    CHECK ("actor" ~ '^[a-z0-9][a-z0-9:._@/-]*$'),
  CONSTRAINT "corpus_index_generation_flips_reason_present"
    CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "corpus_index_generation_flips_digest_shape"
    CHECK ("evidence_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "corpus_index_generation_flips_pair_distinct"
    CHECK ("from_generation" IS DISTINCT FROM "to_generation")
);--> statement-breakpoint

ALTER TABLE "corpus_index_generation_flips" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_generation_flips" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- FORCE RLS also binds the owner-run operator transaction, so the owner gets
-- its own policy; grants decide what every other role may do.
CREATE POLICY "corpus_index_generation_flips_owner_access"
  ON "corpus_index_generation_flips" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_generation_flips'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_generation_flips'::regclass));--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_generation_flips"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_generation_flips"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint

-- Append-only: the app reads receipts, ingestion records them, nothing
-- updates or deletes one.
REVOKE ALL PRIVILEGES ON TABLE "corpus_index_generation_flips" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "corpus_index_generation_flips" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "corpus_index_generation_flips"
  TO stella_ingestion;
