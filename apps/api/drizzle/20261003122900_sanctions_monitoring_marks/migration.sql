-- requires: 20261003122800_sanctions_monitoring
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE public.sanctions_contact_marks (
 organization_id varchar(128) NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
 contact_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
 scheduled_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, contact_id),
 CONSTRAINT sanctions_marks_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES public.contacts(organization_id, id) ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX sanctions_contact_marks_due_idx ON public.sanctions_contact_marks (scheduled_at, organization_id, contact_id);--> statement-breakpoint
CREATE TABLE public.sanctions_organization_marks (
 organization_id varchar(128) PRIMARY KEY REFERENCES public.organization(id) ON DELETE CASCADE,
 generation bigint NOT NULL DEFAULT 1
);--> statement-breakpoint
ALTER TABLE public.sanctions_contact_marks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sanctions_contact_marks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sanctions_contact_marks TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON public.sanctions_contact_marks FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON public.sanctions_contact_marks FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON public.sanctions_contact_marks FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON public.sanctions_contact_marks FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_contact_marks_owner_access ON public.sanctions_contact_marks FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_contact_marks'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_contact_marks'::regclass));--> statement-breakpoint
ALTER TABLE public.sanctions_organization_marks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sanctions_organization_marks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sanctions_organization_marks TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON public.sanctions_organization_marks FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON public.sanctions_organization_marks FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON public.sanctions_organization_marks FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON public.sanctions_organization_marks FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_organization_marks_owner_access ON public.sanctions_organization_marks FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_organization_marks'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_organization_marks'::regclass));--> statement-breakpoint
CREATE FUNCTION public.mark_sanctions_contact_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 INSERT INTO public.sanctions_contact_marks AS marks (organization_id, contact_id)
 SELECT n.organization_id, n.id FROM new_rows AS n
 ON CONFLICT ON CONSTRAINT sanctions_contact_marks_pkey DO UPDATE SET generation = marks.generation + 1, scheduled_at = now();
 RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER contacts_sanctions_mark_insert AFTER INSERT ON public.contacts
 REFERENCING NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION public.mark_sanctions_contact_insert();--> statement-breakpoint
CREATE FUNCTION public.mark_sanctions_organization_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 INSERT INTO public.sanctions_organization_marks AS marks (organization_id)
 SELECT n.organization_id FROM new_rows AS n
 ON CONFLICT ON CONSTRAINT sanctions_organization_marks_pkey DO UPDATE SET generation = marks.generation + 1;
 RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER organization_sanctions_mark_insert AFTER INSERT ON public.organization_settings
 REFERENCING NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION public.mark_sanctions_organization_insert();--> statement-breakpoint
CREATE FUNCTION public.mark_sanctions_contact_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 INSERT INTO public.sanctions_contact_marks AS marks (organization_id, contact_id)
 SELECT n.organization_id, n.id FROM new_rows AS n JOIN old_rows AS o ON o.id = n.id WHERE ROW(n.display_name, n.organization_name, n.registration_number, n.tax_id, n.date_of_birth_year, n.date_of_birth_month, n.date_of_birth_day, n.nationality_codes, n.type, n.sanctions_monitoring_mode) IS DISTINCT FROM ROW(o.display_name, o.organization_name, o.registration_number, o.tax_id, o.date_of_birth_year, o.date_of_birth_month, o.date_of_birth_day, o.nationality_codes, o.type, o.sanctions_monitoring_mode)
 ON CONFLICT ON CONSTRAINT sanctions_contact_marks_pkey DO UPDATE SET generation = marks.generation + 1, scheduled_at = now();
 RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER contacts_sanctions_mark_update AFTER UPDATE ON public.contacts
 REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
 FOR EACH STATEMENT EXECUTE FUNCTION public.mark_sanctions_contact_update();--> statement-breakpoint
CREATE FUNCTION public.mark_sanctions_organization_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 INSERT INTO public.sanctions_organization_marks AS marks (organization_id)
 SELECT n.organization_id FROM new_rows AS n JOIN old_rows AS o ON o.organization_id = n.organization_id WHERE n.sanctions_monitoring_mode IS DISTINCT FROM o.sanctions_monitoring_mode
 ON CONFLICT ON CONSTRAINT sanctions_organization_marks_pkey DO UPDATE SET generation = marks.generation + 1;
 RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER organization_sanctions_mark_update AFTER UPDATE ON public.organization_settings
 REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
 FOR EACH STATEMENT EXECUTE FUNCTION public.mark_sanctions_organization_update();--> statement-breakpoint
