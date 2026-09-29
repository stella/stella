SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

CREATE TABLE "case_law_court_directory_ranks" (
  "country" text NOT NULL,
  "court_id" text NOT NULL,
  "tier" smallint NOT NULL,
  "weight" smallint NOT NULL,
  CONSTRAINT "case_law_court_directory_ranks_pkey" PRIMARY KEY("country", "court_id")
);--> statement-breakpoint

ALTER TABLE "case_law_court_directory_ranks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_court_directory_ranks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Row security is forced, so the owner is bound by policy too, and the seed
-- migrations write these rows as the owner. The owner role is named per
-- deployment, so the policy cannot name it; table privileges decide who
-- reaches the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all, stella_ingestion the writes granted below, and every other granted role SELECT only, which its own policy already allows on every row
CREATE POLICY "case_law_court_directory_rank_owner_access" ON "case_law_court_directory_ranks"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_court_directory_ranks" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_court_directory_ranks" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT (country, court_id, tier, weight) ON TABLE "case_law_court_directory_ranks" TO stella_case_law_analysis_reader;--> statement-breakpoint
GRANT SELECT (country, court_id, tier, weight) ON TABLE "case_law_court_directory_ranks" TO stella_public_law_reader;--> statement-breakpoint

CREATE POLICY "case_law_global_access" ON "case_law_court_directory_ranks"
  AS PERMISSIVE FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_court_directory_ranks"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_analysis_reader_read" ON "case_law_court_directory_ranks"
  AS PERMISSIVE FOR SELECT TO stella_case_law_analysis_reader USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_court_directory_ranks"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader USING (true);
