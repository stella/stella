-- requires: 20261007090100_validate_case_law_citation_review_provenance
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

CREATE TABLE "search_history_entries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "court_id" varchar(128),
  "statute_number" varchar(32),
  "statute_year" varchar(4),
  "lookup_key" varchar(64) NOT NULL,
  "ciphertext" bytea NOT NULL,
  "iv" bytea NOT NULL,
  "first_used_at" timestamptz DEFAULT now() NOT NULL,
  "last_used_at" timestamptz DEFAULT now() NOT NULL,
  "use_count" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "search_history_entries_kind_check" CHECK ("kind" IN ('search', 'decision', 'statute')),
  CONSTRAINT "search_history_entries_use_count_check" CHECK ("use_count" >= 1),
  CONSTRAINT "search_history_entries_used_order_check" CHECK ("first_used_at" <= "last_used_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX "search_history_entries_owner_lookup_idx" ON "search_history_entries" ("organization_id", "user_id", "kind", "lookup_key");--> statement-breakpoint
CREATE INDEX "search_history_entries_owner_recent_idx" ON "search_history_entries" ("organization_id", "user_id", "last_used_at", "id");--> statement-breakpoint
CREATE INDEX "search_history_entries_owner_kind_recent_idx" ON "search_history_entries" ("organization_id", "user_id", "kind", "last_used_at", "id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "search_history_entries" TO stella;--> statement-breakpoint
ALTER TABLE "search_history_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_history_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Each policy pins both the signed-in user and the active organization: the
-- history is its user's alone in that organization. UPDATE checks the
-- resulting row too, so an entry cannot move to another user or organization.
CREATE POLICY "user_select" ON "search_history_entries" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "search_history_entries" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "search_history_entries" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "search_history_entries" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
-- Row security is forced, so the owning role (member removal, account
-- deletion, the review reset) is admitted by name; the app role never is.
CREATE POLICY "search_history_entries_owner" ON "search_history_entries" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_entries'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_entries'::regclass));
