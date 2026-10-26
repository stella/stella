-- requires: 20261010003000_search_history_import_cutoffs
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Nullable: entries recorded before history was kept per country have none.
ALTER TABLE "search_history_entries" ADD COLUMN "jurisdiction" varchar(8);
--> statement-breakpoint
ALTER TABLE "search_history_entries" ADD COLUMN "jurisdiction_repair_failed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "search_history_entries" ADD CONSTRAINT "search_history_entries_jurisdiction_check"
  CHECK ("jurisdiction" IS NULL OR "jurisdiction" IN ('AUT', 'CZE', 'EU', 'GBR', 'HUN', 'POL', 'SVK', 'USA')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "search_history_owners" ADD COLUMN "legacy_cleared_at" timestamptz;
--> statement-breakpoint

CREATE TABLE "search_history_jurisdiction_clears" (
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "jurisdiction" varchar(8) NOT NULL,
  "cleared_at" timestamptz NOT NULL,
  CONSTRAINT "search_history_jurisdiction_clears_pk" PRIMARY KEY ("organization_id", "user_id", "jurisdiction"),
  CONSTRAINT "search_history_jurisdiction_clears_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "search_history_jurisdiction_clears_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "search_history_jurisdiction_clears_owner_fk" FOREIGN KEY ("organization_id", "user_id") REFERENCES "search_history_owners"("organization_id", "user_id") ON DELETE cascade,
  CONSTRAINT "search_history_jurisdiction_clears_country_check" CHECK ("jurisdiction" IN ('AUT', 'CZE', 'EU', 'GBR', 'HUN', 'POL', 'SVK', 'USA'))
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "search_history_jurisdiction_clears" TO stella;
--> statement-breakpoint
ALTER TABLE "search_history_jurisdiction_clears" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "search_history_jurisdiction_clears" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "user_select" ON "search_history_jurisdiction_clears" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "user_insert" ON "search_history_jurisdiction_clears" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "user_update" ON "search_history_jurisdiction_clears" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "user_delete" ON "search_history_jurisdiction_clears" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "search_history_jurisdiction_clears_owner" ON "search_history_jurisdiction_clears" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_jurisdiction_clears'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.search_history_jurisdiction_clears'::regclass));
--> statement-breakpoint

-- Every history writer locks its owner before writing entries. The trigger
-- keeps older API tasks from acknowledging a stale import after a newer task
-- clears one country; it never discards another country's encrypted history.
CREATE FUNCTION public.search_history_entries_clear_cutoff_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fence$
DECLARE
  cutoff timestamptz;
BEGIN
  SELECT legacy_cleared_at INTO cutoff
    FROM public.search_history_owners
   WHERE organization_id = NEW.organization_id AND user_id = NEW.user_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Search history owner lock is required before writing an entry',
      CONSTRAINT = 'search_history_entries_clear_cutoff_fence',
      SCHEMA = 'public', TABLE = 'search_history_entries';
  END IF;
  IF NEW.jurisdiction IS NOT NULL THEN
    SELECT cleared_at INTO cutoff
      FROM public.search_history_jurisdiction_clears
     WHERE organization_id = NEW.organization_id
       AND user_id = NEW.user_id
       AND jurisdiction = NEW.jurisdiction;
  END IF;
  IF cutoff IS NOT NULL AND NEW.first_used_at <= cutoff THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Search history import predates a country clear; retry on a current server',
      CONSTRAINT = 'search_history_entries_clear_cutoff_fence',
      SCHEMA = 'public', TABLE = 'search_history_entries';
  END IF;
  RETURN NEW;
END
$fence$;
--> statement-breakpoint
CREATE TRIGGER search_history_entries_clear_cutoff_insert
  BEFORE INSERT ON public.search_history_entries
  FOR EACH ROW EXECUTE FUNCTION public.search_history_entries_clear_cutoff_fence();
--> statement-breakpoint
-- The old upsert's LEAST(first_used_at, excluded.first_used_at) can move an
-- existing post-clear row backward. Its BEFORE INSERT already took the owner
-- lock before the conflict row; this second check is reentrant.
CREATE TRIGGER search_history_entries_clear_cutoff_update
  BEFORE UPDATE OF first_used_at ON public.search_history_entries
  FOR EACH ROW WHEN (NEW.first_used_at < OLD.first_used_at)
  EXECUTE FUNCTION public.search_history_entries_clear_cutoff_fence();
