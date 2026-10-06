-- requires: 20261003122900_sanctions_monitoring_marks
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE public.sanctions_monitoring_backfills (
 organization_id varchar(128) NOT NULL CONSTRAINT sanctions_backfills_organization_fk REFERENCES public.organization(id) ON DELETE CASCADE,
 source_id text NOT NULL CONSTRAINT sanctions_backfills_source_fk REFERENCES public.sanctions_sources(id),
 edition_id uuid CONSTRAINT sanctions_backfills_edition_fk REFERENCES public.sanctions_editions(id),
 cursor_contact_id uuid,
 generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
 state text NOT NULL DEFAULT 'pending' CONSTRAINT "sanctions_monitoring_backfills_state_check" CHECK (state IN ('pending', 'complete')),
 scheduled_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, source_id)
);--> statement-breakpoint
CREATE INDEX sanctions_monitoring_backfills_due_idx ON public.sanctions_monitoring_backfills (state, scheduled_at, organization_id, source_id);--> statement-breakpoint
ALTER TABLE public.sanctions_monitoring_backfills ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sanctions_monitoring_backfills FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sanctions_monitoring_backfills TO stella;--> statement-breakpoint
CREATE POLICY organization_select ON public.sanctions_monitoring_backfills FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_insert ON public.sanctions_monitoring_backfills FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_update ON public.sanctions_monitoring_backfills FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY organization_delete ON public.sanctions_monitoring_backfills FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY sanctions_monitoring_backfills_owner_access ON public.sanctions_monitoring_backfills FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_monitoring_backfills'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.sanctions_monitoring_backfills'::regclass));--> statement-breakpoint
CREATE TABLE public.sanctions_edition_fanouts (
 source_id text PRIMARY KEY REFERENCES public.sanctions_sources(id),
 edition_id uuid REFERENCES public.sanctions_editions(id),
 cursor_organization_id varchar(128),
 freshness_status text NOT NULL DEFAULT 'unknown' CONSTRAINT "sanctions_edition_fanouts_freshness_check" CHECK (freshness_status IN ('unknown', 'fresh', 'unavailable')),
 state text NOT NULL DEFAULT 'pending' CONSTRAINT "sanctions_edition_fanouts_state_check" CHECK (state IN ('pending', 'complete'))
);--> statement-breakpoint
ALTER TABLE public.sanctions_edition_fanouts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sanctions_edition_fanouts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON public.sanctions_edition_fanouts TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.sanctions_edition_fanouts TO stella_ingestion;--> statement-breakpoint
CREATE POLICY case_law_global_access ON public.sanctions_edition_fanouts FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY case_law_ingestion_access ON public.sanctions_edition_fanouts FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE FUNCTION public.enqueue_sanctions_edition_fanout() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 INSERT INTO public.sanctions_edition_fanouts (source_id, edition_id)
 VALUES (NEW.id, NEW.active_edition_id)
 ON CONFLICT ON CONSTRAINT sanctions_edition_fanouts_pkey DO UPDATE
 SET edition_id = excluded.edition_id, cursor_organization_id = NULL, state = 'pending', freshness_status = 'unknown';
 RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER sanctions_new_source_fanout AFTER INSERT ON public.sanctions_sources
 FOR EACH ROW EXECUTE FUNCTION public.enqueue_sanctions_edition_fanout();--> statement-breakpoint
CREATE TRIGGER sanctions_active_edition_fanout AFTER UPDATE OF active_edition_id ON public.sanctions_sources
 FOR EACH ROW WHEN (OLD.active_edition_id IS DISTINCT FROM NEW.active_edition_id)
 EXECUTE FUNCTION public.enqueue_sanctions_edition_fanout();--> statement-breakpoint

-- Initialize the bounded reference registry before a tenant drain can store unavailable coverage.
SET LOCAL ROLE stella_ingestion;--> statement-breakpoint
INSERT INTO public.sanctions_sources (id, issuer, marker_url) VALUES
('eu', 'European Union', 'https://data.europa.eu/api/hub/repo/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions'),
('un', 'United Nations', 'https://scsanctions.un.org/resources/xml/en/consolidated.xml'),
('cz', 'Czech Republic', 'https://mzv.gov.cz/jnp/cz/o_ministerstvu/otevrena_data/index_5.html'),
('us-sdn', 'United States', 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML'),
('us-non-sdn', 'United States', 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML'),
('uk', 'United Kingdom', 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml'),
('ch', 'Switzerland', 'https://www.sesam.search.admin.ch/sesam-search-web/pages/downloadXmlGesamtliste.xhtml?action=downloadXmlGesamtlisteAction&lang=de')
ON CONFLICT ON CONSTRAINT sanctions_sources_pkey DO NOTHING;--> statement-breakpoint
RESET ROLE;
