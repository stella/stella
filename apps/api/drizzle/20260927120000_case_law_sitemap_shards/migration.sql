SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The shards the public case-law sitemap index lists, written whole by a
-- background refresh so a public read lists them without counting the corpus.
CREATE TABLE "case_law_sitemap_shards" (
  "country" varchar(3) NOT NULL,
  "year" varchar(7) NOT NULL,
  "month" varchar(2) NOT NULL,
  "bucket" varchar(3) NOT NULL,
  "total" integer NOT NULL,
  "last_modified_at" timestamptz NOT NULL,
  "refreshed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_sitemap_shards_pkey" PRIMARY KEY ("country", "year", "month", "bucket"),
  CONSTRAINT "case_law_sitemap_shards_total_positive" CHECK ("total" > 0)
);--> statement-breakpoint

ALTER TABLE "case_law_sitemap_shards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_sitemap_shards" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Row security is forced, so the owner-run refresh is bound by policy too.
-- The owner role is named per deployment, so the policy cannot name it; table
-- privileges decide who reaches the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all, stella none (revoked below) and the public-law reader SELECT on the listed columns only
CREATE POLICY "case_law_sitemap_shard_owner_access" ON "case_law_sitemap_shards"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_sitemap_shards"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_sitemap_shards" FROM stella;--> statement-breakpoint
GRANT SELECT ("country", "year", "month", "bucket", "last_modified_at")
  ON TABLE "case_law_sitemap_shards"
  TO "stella_public_law_reader";
