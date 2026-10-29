SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

CREATE TABLE "case_law_sitemap_drain_progress" (
  "country" text NOT NULL,
  "year" text NOT NULL,
  "month" text NOT NULL,
  "covered_before" xid8 NOT NULL,
  "retired_through" xid8 DEFAULT '0'::xid8 NOT NULL,
  PRIMARY KEY ("country", "year", "month")
);--> statement-breakpoint
ALTER TABLE "case_law_sitemap_drain_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_sitemap_drain_progress" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed permissive-policy - table privileges restrict recount progress to the owner; no application or writer role is granted access
CREATE POLICY "case_law_sitemap_drain_owner_access" ON "case_law_sitemap_drain_progress"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_sitemap_drain_progress" FROM stella;--> statement-breakpoint
