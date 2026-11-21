SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- One country's sitemap month counts, staged by the background refresh until
-- every public country is counted and the shard snapshot is replaced whole.
CREATE TABLE "case_law_sitemap_shard_counts" (
  "country" varchar(3) PRIMARY KEY NOT NULL,
  "months" jsonb NOT NULL,
  "pages" integer NOT NULL,
  "counted_at" timestamptz NOT NULL,
  CONSTRAINT "case_law_sitemap_shard_counts_pages_positive" CHECK ("pages" > 0)
);--> statement-breakpoint

ALTER TABLE "case_law_sitemap_shard_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_sitemap_shard_counts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Row security is forced, so the owner-run refresh is bound by policy too.
-- The owner role is named per deployment, so the policy cannot name it; table
-- privileges decide who reaches the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all and stella none (revoked below); no other role is granted
CREATE POLICY "case_law_sitemap_shard_count_owner_access" ON "case_law_sitemap_shard_counts"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_sitemap_shard_counts" FROM stella;
