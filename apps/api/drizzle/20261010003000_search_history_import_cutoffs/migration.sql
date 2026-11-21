-- requires: 20261008140000_search_history_entries
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

CREATE TABLE "search_history_owners" (
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "cleared_at" timestamptz,
  "tombstone_cutoff_at" timestamptz,
  CONSTRAINT "search_history_owners_organization_id_user_id_pk" PRIMARY KEY ("organization_id", "user_id")
);--> statement-breakpoint
CREATE TABLE "search_history_tombstones" (
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "lookup_key" varchar(64) NOT NULL,
  "deleted_at" timestamptz NOT NULL,
  CONSTRAINT "search_history_tombstones_pk" PRIMARY KEY ("organization_id", "user_id", "kind", "lookup_key"),
  CONSTRAINT "search_history_tombstones_owner_fk" FOREIGN KEY ("organization_id", "user_id") REFERENCES "search_history_owners"("organization_id", "user_id") ON DELETE cascade,
  CONSTRAINT "search_history_tombstones_kind_check" CHECK ("kind" IN ('search', 'decision', 'statute'))
);--> statement-breakpoint
CREATE INDEX "search_history_tombstones_owner_deleted_idx" ON "search_history_tombstones" ("organization_id", "user_id", "deleted_at", "kind", "lookup_key");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "search_history_owners" TO stella;--> statement-breakpoint
ALTER TABLE "search_history_owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_history_owners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Each policy pins both the signed-in user and the active organization: the
-- history is its user's alone in that organization. UPDATE checks the
-- resulting row too, so an entry cannot move to another user or organization.
CREATE POLICY "user_select" ON "search_history_owners" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "search_history_owners" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "search_history_owners" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "search_history_owners" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
-- Row security is forced, so the owning role (member removal, account
-- deletion, the review reset) is admitted by name; the app role never is.
CREATE POLICY "search_history_owners_owner" ON "search_history_owners" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_owners'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_owners'::regclass));

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "search_history_tombstones" TO stella;--> statement-breakpoint
ALTER TABLE "search_history_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_history_tombstones" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Each policy pins both the signed-in user and the active organization: the
-- history is its user's alone in that organization. UPDATE checks the
-- resulting row too, so an entry cannot move to another user or organization.
CREATE POLICY "user_select" ON "search_history_tombstones" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "search_history_tombstones" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "search_history_tombstones" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "search_history_tombstones" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
-- Row security is forced, so the owning role (member removal, account
-- deletion, the review reset) is admitted by name; the app role never is.
CREATE POLICY "search_history_tombstones_owner" ON "search_history_tombstones" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_tombstones'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_tombstones'::regclass));
