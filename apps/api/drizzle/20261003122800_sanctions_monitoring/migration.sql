-- requires: 20261003121900_sanctions_sources
-- requires: 20261003122700_sanctions_monitoring_contact_index
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_unique" UNIQUE USING INDEX "contacts_org_id_unique";--> statement-breakpoint
-- New columns give existing rows valid defaults; the online phase validates after DDL locks are released.
ALTER TABLE contacts ADD COLUMN sanctions_monitoring_mode text NOT NULL DEFAULT 'included', ADD CONSTRAINT "contacts_sanctions_monitoring_mode_check" CHECK (sanctions_monitoring_mode IN ('included', 'excluded')) NOT VALID;--> statement-breakpoint
ALTER TABLE organization_settings ADD COLUMN sanctions_monitoring_mode text NOT NULL DEFAULT 'enabled', ADD CONSTRAINT "organization_settings_sanctions_monitoring_mode_check" CHECK (sanctions_monitoring_mode IN ('enabled', 'disabled')) NOT VALID;--> statement-breakpoint
CREATE TABLE sanctions_contact_screenings (
  organization_id varchar(128) NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  source_id text NOT NULL REFERENCES sanctions_sources(id),
  edition_id uuid CONSTRAINT sanctions_screenings_edition_fk REFERENCES sanctions_editions(id),
  status text NOT NULL,
  reason text,
  contact_fingerprint text NOT NULL,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, contact_id, source_id),
  CONSTRAINT "sanctions_contact_screenings_status_check" CHECK (status IN ('clear', 'possible-match', 'unavailable', 'excluded')),
  CONSTRAINT "sanctions_contact_screenings_clear_edition_check" CHECK (status <> 'clear' OR edition_id IS NOT NULL),
  CONSTRAINT sanctions_screenings_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id, id) ON DELETE CASCADE
);--> statement-breakpoint
ALTER TABLE sanctions_contact_screenings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sanctions_contact_screenings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_contact_screenings TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON sanctions_contact_screenings FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON sanctions_contact_screenings FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON sanctions_contact_screenings FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON sanctions_contact_screenings FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_contact_screenings_owner_access ON sanctions_contact_screenings FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_contact_screenings'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_contact_screenings'::regclass));--> statement-breakpoint
CREATE TABLE sanctions_contact_matches (
  organization_id varchar(128) NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  source_id text NOT NULL REFERENCES sanctions_sources(id),
  source_entry_id text NOT NULL,
  edition_id uuid NOT NULL REFERENCES sanctions_editions(id),
  state text NOT NULL,
  disposition text NOT NULL DEFAULT 'needs-review',
  reviewed_by text REFERENCES "user"(id) ON DELETE SET NULL,
  review_reason text,
  contact_fingerprint text NOT NULL,
  entry_hash text NOT NULL,
  match jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, contact_id, source_id, source_entry_id),
  CONSTRAINT "sanctions_contact_matches_state_check" CHECK (state IN ('active', 'lapsed')),
  CONSTRAINT "sanctions_contact_matches_disposition_check" CHECK (disposition IN ('needs-review', 'dismissed')),
  CONSTRAINT sanctions_matches_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id, id) ON DELETE CASCADE
);--> statement-breakpoint
ALTER TABLE sanctions_contact_matches ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sanctions_contact_matches FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_contact_matches TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON sanctions_contact_matches FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON sanctions_contact_matches FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON sanctions_contact_matches FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON sanctions_contact_matches FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_contact_matches_owner_access ON sanctions_contact_matches FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_contact_matches'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_contact_matches'::regclass));--> statement-breakpoint
CREATE TABLE sanctions_screening_events (
  id uuid PRIMARY KEY NOT NULL,
  organization_id varchar(128) NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  source_id text NOT NULL REFERENCES sanctions_sources(id),
  source_entry_id text NOT NULL,
  type text NOT NULL,
  old_edition_id uuid CONSTRAINT sanctions_events_old_edition_fk REFERENCES sanctions_editions(id),
  new_edition_id uuid NOT NULL CONSTRAINT sanctions_events_new_edition_fk REFERENCES sanctions_editions(id),
  reason text NOT NULL,
  old_match jsonb,
  new_match jsonb,
  created_at timestamptz NOT NULL,
  CONSTRAINT "sanctions_screening_events_type_check" CHECK (type IN ('new', 'changed', 'lapsed', 'reopened', 'dismissed', 'review-restored')),
  CONSTRAINT sanctions_events_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id, id) ON DELETE CASCADE
);--> statement-breakpoint
ALTER TABLE sanctions_screening_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sanctions_screening_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_screening_events TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON sanctions_screening_events FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON sanctions_screening_events FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON sanctions_screening_events FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON sanctions_screening_events FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_screening_events_owner_access ON sanctions_screening_events FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_screening_events'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_screening_events'::regclass));--> statement-breakpoint
CREATE INDEX sanctions_contact_matches_reviewed_by_idx ON sanctions_contact_matches (reviewed_by);--> statement-breakpoint
CREATE INDEX sanctions_screening_events_org_contact_time_idx ON sanctions_screening_events (organization_id, contact_id, created_at, id);--> statement-breakpoint
CREATE POLICY events_no_update ON sanctions_screening_events AS RESTRICTIVE FOR UPDATE TO public USING (false);--> statement-breakpoint
CREATE POLICY events_no_delete ON sanctions_screening_events AS RESTRICTIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
