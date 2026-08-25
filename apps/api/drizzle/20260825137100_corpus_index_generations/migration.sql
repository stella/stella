SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- One generation resolves to one closed cluster identity. Endpoints and
-- credentials remain trusted deployment configuration rather than data that
-- can redirect an internal HTTP client.
CREATE TABLE "corpus_index_generations" (
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "cluster" text NOT NULL,
  "manifest_digest" varchar(64) NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_generations_pkey"
    PRIMARY KEY ("family", "generation"),
  CONSTRAINT "corpus_index_generations_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_generations_cluster_values"
    CHECK ("cluster" IN ('q08','q09')),
  CONSTRAINT "corpus_index_generations_status_values"
    CHECK ("status" IN ('building','serving','retiring','retired')),
  CONSTRAINT "corpus_index_generations_manifest_digest_shape"
    CHECK ("manifest_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "corpus_index_generations_name_matches_family"
    CHECK (CASE "family"
      WHEN 'case_law' THEN "generation" ~ '^case_law_v[1-9][0-9]*$'
      WHEN 'legislation' THEN "generation" ~ '^legislation_v[1-9][0-9]*$'
      ELSE false
    END)
);--> statement-breakpoint

CREATE UNIQUE INDEX "corpus_index_generations_serving_family_uidx"
  ON "corpus_index_generations" ("family")
  WHERE "status" = 'serving';--> statement-breakpoint

CREATE FUNCTION "prevent_corpus_index_generation_retarget"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW."family", NEW."generation", NEW."cluster", NEW."manifest_digest") IS DISTINCT FROM
     (OLD."family", OLD."generation", OLD."cluster", OLD."manifest_digest") THEN
    RAISE EXCEPTION 'corpus index generation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "corpus_index_generations_identity_immutable"
  BEFORE UPDATE ON "corpus_index_generations"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_corpus_index_generation_retarget"();--> statement-breakpoint

ALTER TABLE "corpus_index_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_generations"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_generations"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access"
  ON "corpus_index_generations"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader
  USING (true);--> statement-breakpoint

GRANT SELECT ON TABLE "corpus_index_generations" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE
  ON TABLE "corpus_index_generations" TO stella_ingestion;--> statement-breakpoint
GRANT UPDATE ("status", "updated_at")
  ON TABLE "corpus_index_generations" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ("family", "generation", "cluster", "manifest_digest", "status")
  ON TABLE "corpus_index_generations" TO stella_public_law_reader;
