-- requires: 20261003121900_sanctions_sources
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN sanctions_monitoring_mode text NOT NULL DEFAULT 'included', ADD CONSTRAINT contacts_sanctions_monitoring_mode_check CHECK (sanctions_monitoring_mode IN ('included', 'excluded')), ADD CONSTRAINT contacts_org_id_unique UNIQUE (organization_id, id);--> statement-breakpoint
ALTER TABLE organization_settings ADD COLUMN sanctions_monitoring_mode text NOT NULL DEFAULT 'enabled', ADD CONSTRAINT organization_settings_sanctions_monitoring_mode_check CHECK (sanctions_monitoring_mode IN ('enabled', 'disabled'));--> statement-breakpoint
CREATE TABLE sanctions_contact_marks (
  organization_id varchar(128) NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1,
  marked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sanctions_contact_marks_generation_check CHECK (generation > 0),
  FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id, id) ON DELETE CASCADE
);--> statement-breakpoint
ALTER TABLE sanctions_contact_marks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sanctions_contact_marks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_contact_marks TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON sanctions_contact_marks FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON sanctions_contact_marks FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON sanctions_contact_marks FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON sanctions_contact_marks FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_contact_marks_owner_access ON sanctions_contact_marks FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_contact_marks'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_contact_marks'::regclass));--> statement-breakpoint
CREATE TABLE sanctions_organization_marks (
  organization_id varchar(128) NOT NULL REFERENCES organization(id) ON DELETE CASCADE PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1,
  marked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sanctions_organization_marks_generation_check CHECK (generation > 0)
);--> statement-breakpoint
ALTER TABLE sanctions_organization_marks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sanctions_organization_marks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_organization_marks TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON sanctions_organization_marks FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON sanctions_organization_marks FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON sanctions_organization_marks FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON sanctions_organization_marks FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_organization_marks_owner_access ON sanctions_organization_marks FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_organization_marks'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_organization_marks'::regclass));--> statement-breakpoint
CREATE TABLE sanctions_contact_screenings (
  organization_id varchar(128) NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  source_id text NOT NULL REFERENCES sanctions_sources(id),
  edition_id uuid NOT NULL REFERENCES sanctions_editions(id),
  contact_fingerprint text NOT NULL,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, contact_id, source_id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id, id) ON DELETE CASCADE
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
  CONSTRAINT sanctions_contact_matches_state_check CHECK (state IN ('active', 'lapsed')),
  CONSTRAINT sanctions_contact_matches_disposition_check CHECK (disposition IN ('needs-review', 'dismissed')),
  FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id, id) ON DELETE CASCADE
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
  old_edition_id uuid REFERENCES sanctions_editions(id),
  new_edition_id uuid NOT NULL REFERENCES sanctions_editions(id),
  reason text NOT NULL,
  old_match jsonb,
  new_match jsonb,
  created_at timestamptz NOT NULL,
  CONSTRAINT sanctions_screening_events_type_check CHECK (type IN ('new', 'changed', 'lapsed', 'reopened')),
  FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(organization_id, id) ON DELETE CASCADE
);--> statement-breakpoint
ALTER TABLE sanctions_screening_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sanctions_screening_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_screening_events TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON sanctions_screening_events FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON sanctions_screening_events FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON sanctions_screening_events FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON sanctions_screening_events FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_screening_events_owner_access ON sanctions_screening_events FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_screening_events'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_screening_events'::regclass));--> statement-breakpoint
CREATE INDEX sanctions_contact_marks_org_cursor_idx ON sanctions_contact_marks (organization_id, contact_id);--> statement-breakpoint
CREATE INDEX sanctions_screening_events_org_contact_time_idx ON sanctions_screening_events (organization_id, contact_id, created_at, id);--> statement-breakpoint
CREATE POLICY events_no_update ON sanctions_screening_events AS RESTRICTIVE FOR UPDATE TO public USING (false);--> statement-breakpoint
CREATE POLICY events_no_delete ON sanctions_screening_events AS RESTRICTIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
-- Transactional marks cover every contact writer, including batch imports.
CREATE FUNCTION mark_sanctions_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sanctions_contact_marks (organization_id, contact_id)
    VALUES (NEW.organization_id, NEW.id)
    ON CONFLICT ON CONSTRAINT sanctions_contact_marks_pkey DO UPDATE
      SET generation = sanctions_contact_marks.generation + 1, marked_at = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER contacts_sanctions_mark AFTER INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION mark_sanctions_contact();--> statement-breakpoint
CREATE FUNCTION mark_sanctions_organization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sanctions_organization_marks (organization_id)
    VALUES (NEW.organization_id)
    ON CONFLICT ON CONSTRAINT sanctions_organization_marks_pkey DO UPDATE
      SET generation = sanctions_organization_marks.generation + 1, marked_at = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER organization_sanctions_mark AFTER INSERT OR UPDATE OF sanctions_monitoring_mode ON organization_settings
  FOR EACH ROW EXECUTE FUNCTION mark_sanctions_organization();
