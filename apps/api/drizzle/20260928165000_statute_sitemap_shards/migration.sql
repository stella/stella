SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "statute_sitemap_shards" (
  "country" varchar(3) NOT NULL,
  "bucket" varchar(3) NOT NULL,
  "total" integer NOT NULL,
  "lastmod" varchar(10) NOT NULL,
  CONSTRAINT "statute_sitemap_shards_pkey" PRIMARY KEY ("country", "bucket"),
  CONSTRAINT "statute_sitemap_shards_total_positive" CHECK ("total" > 0)
);--> statement-breakpoint

ALTER TABLE "statute_sitemap_shards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "statute_sitemap_shards" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The owner-run refresh needs this policy because row security is forced;
-- table privileges determine which roles can reach the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges restrict the owner refresh and public reader; the request role is revoked below
CREATE POLICY "statute_sitemap_shard_owner_access" ON "statute_sitemap_shards"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "statute_sitemap_shards"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "statute_sitemap_shards" FROM stella;--> statement-breakpoint
GRANT SELECT ("country", "bucket", "lastmod", "total")
  ON TABLE "statute_sitemap_shards"
  TO "stella_public_law_reader";
