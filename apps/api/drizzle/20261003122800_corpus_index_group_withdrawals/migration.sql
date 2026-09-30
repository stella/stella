SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Who withdrew an index group's attestation, and why. The enrollment row
-- keeps only the group's present readiness; this append-only trail keeps
-- each withdrawal, written in the transaction that makes it. A registry row
-- is a global corpus row with no organization, so `audit_logs` cannot hold
-- it; `case_law_index_jobs` records what entered or left the corpus per
-- document. No foreign key: the trail outlives a generation's rebuild, which
-- deletes the enrollment it describes.
CREATE TABLE IF NOT EXISTS "corpus_index_group_withdrawals" (
  "id" bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME "corpus_index_group_withdrawals_id_seq") NOT NULL,
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "index_group" varchar(32) NOT NULL,
  "effective_digest" varchar(64) NOT NULL,
  "actor" varchar(128) NOT NULL,
  "reason" varchar(2048) NOT NULL,
  "withdrawn_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_group_withdrawals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "corpus_index_group_withdrawals_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_group_withdrawals_digest_shape"
    CHECK ("effective_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "corpus_index_group_withdrawals_actor_shape"
    CHECK ("actor" ~ '^[a-z0-9][a-z0-9:._@/-]*$'),
  CONSTRAINT "corpus_index_group_withdrawals_reason_present"
    CHECK (length(btrim("reason")) > 0)
);--> statement-breakpoint

ALTER TABLE "corpus_index_group_withdrawals"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_group_withdrawals"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- FORCE RLS also binds the owner-run withdrawal transaction; grants still
-- limit the application role to SELECT and ingestion to SELECT and INSERT.
-- stella-migration-safety: reviewed permissive-policy - table grants restrict each non-owner role while the owner needs this policy to record withdrawals under forced RLS
CREATE POLICY "corpus_index_group_withdrawals_owner_access"
  ON "corpus_index_group_withdrawals"
  AS PERMISSIVE FOR ALL TO public
  USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_group_withdrawals"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_group_withdrawals"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint

GRANT SELECT ON TABLE "corpus_index_group_withdrawals" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "corpus_index_group_withdrawals"
  TO stella_ingestion;
