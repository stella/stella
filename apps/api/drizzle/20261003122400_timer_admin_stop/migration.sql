-- requires: 20261003122300_global_timers
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
CREATE POLICY "organization_admin_select" ON "time_timers" AS PERMISSIVE FOR SELECT TO stella
  USING ("time_timers"."organization_id" = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
        AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
        AND "member"."role" IN ('owner', 'admin')
    )
    AND "time_timers"."state" = 'running');--> statement-breakpoint
CREATE POLICY "organization_admin_delete" ON "time_timers" AS PERMISSIVE FOR DELETE TO stella
  USING ("time_timers"."organization_id" = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
        AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
        AND "member"."role" IN ('owner', 'admin')
    )
    AND "time_timers"."state" = 'running'
    AND EXISTS (
      SELECT 1 FROM "time_timer_confirmations"
      WHERE "time_timer_confirmations"."timer_id" = "time_timers"."id"
        AND "time_timer_confirmations"."organization_id" = "time_timers"."organization_id"
        AND "time_timer_confirmations"."user_id" = "time_timers"."user_id"
        AND "time_timer_confirmations"."time_entry_id" IS NOT NULL
    ));--> statement-breakpoint
CREATE POLICY "organization_admin_select" ON "time_timer_confirmations" AS PERMISSIVE FOR SELECT TO stella
  USING ("time_timer_confirmations"."organization_id" = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
        AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
        AND "member"."role" IN ('owner', 'admin')
    ));--> statement-breakpoint
CREATE POLICY "organization_admin_insert" ON "time_timer_confirmations" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ("time_timer_confirmations"."organization_id" = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
        AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
        AND "member"."role" IN ('owner', 'admin')
    )
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = "time_timer_confirmations"."organization_id"
        AND "member"."user_id" = "time_timer_confirmations"."user_id"
    )
    AND EXISTS (
      SELECT 1 FROM "time_timers"
      WHERE "time_timers"."id" = "time_timer_confirmations"."timer_id"
        AND "time_timers"."organization_id" = "time_timer_confirmations"."organization_id"
        AND "time_timers"."user_id" = "time_timer_confirmations"."user_id"
        AND "time_timers"."state" = 'running'
    )
    AND "time_timer_confirmations"."time_entry_id" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "time_entries"
      WHERE "time_entries"."id" = "time_timer_confirmations"."time_entry_id"
        AND "time_entries"."organization_id" = "time_timer_confirmations"."organization_id"
        AND "time_entries"."user_id" = "time_timer_confirmations"."user_id"
    ));--> statement-breakpoint
CREATE INDEX "time_timers_running_org_id_idx" ON "time_timers" ("organization_id", "id") WHERE "state" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "time_timers_legacy_entry_uidx" ON "time_timers" ("legacy_time_entry_id") WHERE "legacy_time_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "time_entry_timer_states" (
  "entry_id" uuid PRIMARY KEY REFERENCES "time_entries"("id") ON DELETE cascade,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "state" text NOT NULL,
  CONSTRAINT "time_entry_timer_states_state_check" CHECK ("state" IN ('running', 'paused'))
);--> statement-breakpoint
CREATE INDEX "time_entry_timer_states_org_entry_idx" ON "time_entry_timer_states" ("organization_id", "entry_id");--> statement-breakpoint
CREATE FUNCTION public.preserve_time_entry_timer_state_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.entry_id IS DISTINCT FROM NEW.entry_id
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Timer signal identity is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "time_entry_timer_states_identity" BEFORE UPDATE ON "time_entry_timer_states"
FOR EACH ROW EXECUTE FUNCTION public.preserve_time_entry_timer_state_identity();--> statement-breakpoint
CREATE FUNCTION public.sync_time_entry_timer_state() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.legacy_time_entry_id IS NOT NULL THEN
      UPDATE public.time_entry_timer_states SET state = 'paused'
      WHERE entry_id = OLD.legacy_time_entry_id
        AND organization_id = OLD.organization_id AND user_id = OLD.user_id;
      -- FK cascades may remove the entry projection before unlinking its timer.
      IF NOT FOUND AND pg_trigger_depth() = 1 THEN
        RAISE EXCEPTION 'Linked timer signal is missing' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.legacy_time_entry_id IS NOT NULL AND (
      OLD.legacy_time_entry_id IS DISTINCT FROM NEW.legacy_time_entry_id
      OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
      OR OLD.user_id IS DISTINCT FROM NEW.user_id
    ) THEN
      UPDATE public.time_entry_timer_states SET state = 'paused'
      WHERE entry_id = OLD.legacy_time_entry_id
        AND organization_id = OLD.organization_id AND user_id = OLD.user_id;
      -- FK cascades may remove the entry projection before unlinking its timer.
      IF NOT FOUND AND pg_trigger_depth() = 1 THEN
        RAISE EXCEPTION 'Linked timer signal is missing' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF NEW.legacy_time_entry_id IS NOT NULL THEN
    INSERT INTO public.time_entry_timer_states (entry_id, organization_id, user_id, state)
    VALUES (NEW.legacy_time_entry_id, NEW.organization_id, NEW.user_id, NEW.state)
    ON CONFLICT (entry_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id, user_id = EXCLUDED.user_id, state = EXCLUDED.state;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "time_timers_sync_entry_state" AFTER INSERT OR UPDATE OF state, legacy_time_entry_id, organization_id, user_id OR DELETE ON "time_timers"
FOR EACH ROW EXECUTE FUNCTION public.sync_time_entry_timer_state();--> statement-breakpoint
-- stella-migration-safety: reviewed insert-select - copies only linked migrated timers, bounded by their unique legacy entry index; the projection contains no matter content.
INSERT INTO "time_entry_timer_states" (entry_id, organization_id, user_id, state)
SELECT legacy_time_entry_id, organization_id, user_id, state FROM "time_timers" WHERE legacy_time_entry_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entry_timer_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "time_entry_timer_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "time_entry_timer_states" TO stella;--> statement-breakpoint
CREATE POLICY "member_select" ON "time_entry_timer_states" FOR SELECT TO stella USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (SELECT 1 FROM "member" WHERE "member".organization_id = "time_entry_timer_states".organization_id AND "member".user_id = (SELECT current_setting('app.user_id', true)))
  AND (user_id = (SELECT current_setting('app.user_id', true)) OR EXISTS (SELECT 1 FROM "time_entries" WHERE "time_entries".id = "time_entry_timer_states".entry_id AND "time_entries".organization_id = "time_entry_timer_states".organization_id AND "time_entries".user_id = "time_entry_timer_states".user_id))
);--> statement-breakpoint
CREATE POLICY "owner_admin_insert" ON "time_entry_timer_states" FOR INSERT TO stella WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (SELECT 1 FROM "member" WHERE "member".organization_id = "time_entry_timer_states".organization_id AND "member".user_id = (SELECT current_setting('app.user_id', true)) AND ("time_entry_timer_states".user_id = "member".user_id OR "member".role IN ('owner', 'admin')))
  AND (state = 'running') = EXISTS (SELECT 1 FROM "time_timers" WHERE "time_timers".organization_id = "time_entry_timer_states".organization_id AND "time_timers".user_id = "time_entry_timer_states".user_id AND "time_timers".legacy_time_entry_id = "time_entry_timer_states".entry_id AND "time_timers".state = 'running')
  AND EXISTS (SELECT 1 FROM "time_timers" WHERE "time_timers".organization_id = "time_entry_timer_states".organization_id AND "time_timers".user_id = "time_entry_timer_states".user_id AND "time_timers".legacy_time_entry_id = "time_entry_timer_states".entry_id)
);--> statement-breakpoint
CREATE POLICY "owner_admin_update" ON "time_entry_timer_states" FOR UPDATE TO stella USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (SELECT 1 FROM "member" WHERE "member".organization_id = "time_entry_timer_states".organization_id AND "member".user_id = (SELECT current_setting('app.user_id', true)) AND ("time_entry_timer_states".user_id = "member".user_id OR "member".role IN ('owner', 'admin')))
) WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (SELECT 1 FROM "member" WHERE "member".organization_id = "time_entry_timer_states".organization_id AND "member".user_id = (SELECT current_setting('app.user_id', true)) AND ("time_entry_timer_states".user_id = "member".user_id OR "member".role IN ('owner', 'admin')))
  AND (state = 'running') = EXISTS (SELECT 1 FROM "time_timers" WHERE "time_timers".organization_id = "time_entry_timer_states".organization_id AND "time_timers".user_id = "time_entry_timer_states".user_id AND "time_timers".legacy_time_entry_id = "time_entry_timer_states".entry_id AND "time_timers".state = 'running')
);--> statement-breakpoint
