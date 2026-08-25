SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- One generation resolves to one closed cluster identity. Endpoints and
-- credentials remain trusted deployment configuration rather than data that
-- can redirect an internal HTTP client.
CREATE TABLE "corpus_index_generations" (
  "family" varchar(32) NOT NULL,
  "generation" varchar(64) NOT NULL,
  "cluster" varchar(32) NOT NULL,
  "status" varchar(16) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_generations_pkey"
    PRIMARY KEY ("family", "generation"),
  CONSTRAINT "corpus_index_generations_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_generations_cluster_values"
    CHECK ("cluster" IN ('quickwit_08','quickwit_09')),
  CONSTRAINT "corpus_index_generations_status_values"
    CHECK ("status" IN ('building','serving','retiring','retired')),
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
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "corpus_index_generations" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ("family", "generation", "cluster", "status")
  ON TABLE "corpus_index_generations" TO stella_public_law_reader;
