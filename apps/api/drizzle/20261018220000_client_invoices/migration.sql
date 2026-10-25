SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_id uuid;--> statement-breakpoint
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS recorded_description text,
 ADD COLUMN IF NOT EXISTS recorded_quantity numeric(18,4), ADD COLUMN IF NOT EXISTS recorded_unit varchar(32),
 ADD COLUMN IF NOT EXISTS recorded_unit_price bigint, ADD COLUMN IF NOT EXISTS recorded_net_amount bigint;--> statement-breakpoint
-- The online phase builds the indexes, then attaches the tenant key and
-- its NOT VALID original-invoice foreign key through the table gate.
-- Client-level invoices carry a client instead of a single matter.
-- squawk-ignore ban-drop-not-null
ALTER TABLE invoices ALTER COLUMN workspace_id DROP NOT NULL;--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT invoices_scope_check CHECK (workspace_id IS NOT NULL OR client_id IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT invoices_client_id_contacts_id_fk FOREIGN KEY (client_id) REFERENCES contacts(id) ON DELETE NO ACTION NOT VALID;--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT invoices_client_organization_fk FOREIGN KEY (organization_id,client_id) REFERENCES contacts(organization_id,id) NOT VALID;--> statement-breakpoint
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_recorded_snapshot_check CHECK (
 (recorded_description IS NULL AND recorded_quantity IS NULL AND recorded_unit_price IS NULL AND recorded_net_amount IS NULL)
 OR (recorded_description IS NOT NULL AND recorded_quantity IS NOT NULL AND recorded_unit_price IS NOT NULL AND recorded_net_amount IS NOT NULL)
) NOT VALID;--> statement-breakpoint
-- Client backfill runs in bounded committed batches in the online migration phase.
-- stella-migration-safety: reviewed security-definer - Reads complete invoice and linked-original ownership only; tenant and actor membership are checked and search_path is fixed.
CREATE FUNCTION public.stella_invoice_access(invoice_id uuid, org_id text, matter_id uuid, client_id uuid, source_original_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 WITH authorized_original AS (
   SELECT original.id FROM public.invoices original
   WHERE original.id = source_original_id AND original.organization_id = org_id
     AND original.client_id IS NOT DISTINCT FROM stella_invoice_access.client_id
     AND original.workspace_id IS NOT DISTINCT FROM matter_id
     AND original.document_type IN ('invoice', 'advance')
     AND (CASE WHEN original.workspace_id IS NULL
       THEN EXISTS (SELECT 1 FROM public.invoice_lines original_line WHERE original_line.invoice_id = original.id)
       ELSE original.workspace_id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces) END)
     AND NOT EXISTS (SELECT 1 FROM public.invoice_lines original_line WHERE original_line.invoice_id = original.id
       AND original_line.workspace_id NOT IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces))
 )
 SELECT org_id = current_setting('app.organization_id', true)
 AND EXISTS (SELECT 1 FROM public.member m WHERE m.organization_id = org_id
   AND m.user_id = current_setting('app.user_id', true)
   AND (m.role IN ('owner', 'admin') OR (
     -- Empty client invoices stay admin-only, except credit drafts whose whole
     -- original is authorized. Credit notes retain that original scope after
     -- adding lines; they never expose a hidden original through a subset.
     (CASE WHEN matter_id IS NULL
       THEN EXISTS (SELECT 1 FROM public.invoice_lines any_line WHERE any_line.invoice_id = stella_invoice_access.invoice_id)
         OR EXISTS (SELECT 1 FROM authorized_original)
       ELSE matter_id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces) END)
     AND NOT EXISTS (SELECT 1 FROM public.invoice_lines l WHERE l.invoice_id = stella_invoice_access.invoice_id
       AND l.workspace_id NOT IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces))
     AND (source_original_id IS NULL OR EXISTS (SELECT 1 FROM authorized_original))
   )))
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_invoice_access(uuid,text,uuid,uuid,uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_invoice_access(uuid,text,uuid,uuid,uuid) TO stella;--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Enforces invoice/client/matter tenant consistency for old and new writers; fixed search path and trigger-only use.
CREATE FUNCTION public.stella_invoice_client_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE invoice_row public.invoices; matter_row public.workspaces;
BEGIN
 IF TG_TABLE_NAME = 'invoices' THEN
   IF NEW.workspace_id IS NOT NULL THEN
     SELECT * INTO matter_row FROM public.workspaces
       WHERE id = NEW.workspace_id AND organization_id = NEW.organization_id FOR NO KEY UPDATE;
     IF NEW.client_id IS NULL THEN
       NEW.client_id := matter_row.client_id;
     END IF;
     IF NEW.client_id IS NOT NULL AND (matter_row.id IS NULL OR matter_row.client_id IS DISTINCT FROM NEW.client_id) THEN
       RAISE EXCEPTION 'Invoice matter must belong to its client' USING ERRCODE = '23514';
     END IF;
   END IF;
   IF NEW.original_invoice_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.invoices original WHERE original.id = NEW.original_invoice_id AND original.organization_id = NEW.organization_id
       AND original.client_id IS NOT DISTINCT FROM NEW.client_id
       AND original.workspace_id IS NOT DISTINCT FROM NEW.workspace_id) THEN
     RAISE EXCEPTION 'Original invoice must have the same client and scope' USING ERRCODE = '23514';
   END IF;
   IF EXISTS (SELECT 1 FROM public.invoice_lines l JOIN public.workspaces w ON w.id = l.workspace_id
     WHERE l.invoice_id = NEW.id AND (l.organization_id <> NEW.organization_id
       OR (NEW.workspace_id IS NOT NULL AND NEW.workspace_id <> l.workspace_id)
       OR (NEW.client_id IS NOT NULL AND w.client_id IS DISTINCT FROM NEW.client_id))) THEN
     RAISE EXCEPTION 'Invoice lines must belong to the invoice client and tenant' USING ERRCODE = '23514';
   END IF;
   RETURN NEW;
 ELSIF TG_TABLE_NAME = 'workspaces' THEN
   IF EXISTS (SELECT 1 FROM public.invoices i
     WHERE i.workspace_id = NEW.id AND i.client_id IS NOT NULL AND i.client_id IS DISTINCT FROM NEW.client_id)
   OR EXISTS (SELECT 1 FROM public.invoice_lines l JOIN public.invoices i ON i.id = l.invoice_id
     WHERE l.workspace_id = NEW.id AND i.client_id IS NOT NULL AND i.client_id IS DISTINCT FROM NEW.client_id) THEN
     RAISE EXCEPTION 'An invoiced matter must retain its invoice client' USING ERRCODE = '23514';
   END IF;
   RETURN NEW;
 END IF;
 SELECT * INTO matter_row FROM public.workspaces WHERE id = NEW.workspace_id FOR NO KEY UPDATE;
 SELECT * INTO invoice_row FROM public.invoices WHERE id = NEW.invoice_id FOR UPDATE;
 IF invoice_row.id IS NULL OR matter_row.id IS NULL OR invoice_row.organization_id <> NEW.organization_id
   OR matter_row.organization_id <> NEW.organization_id
   OR (invoice_row.workspace_id IS NOT NULL AND invoice_row.workspace_id <> NEW.workspace_id)
   OR (invoice_row.client_id IS NOT NULL AND matter_row.client_id IS DISTINCT FROM invoice_row.client_id) THEN
   RAISE EXCEPTION 'Invoice lines must belong to the invoice client and tenant' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_invoice_client_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER invoices_client_guard BEFORE INSERT OR UPDATE OF client_id, workspace_id, organization_id, original_invoice_id ON invoices FOR EACH ROW EXECUTE FUNCTION public.stella_invoice_client_guard();--> statement-breakpoint
CREATE TRIGGER invoice_lines_client_guard BEFORE INSERT OR UPDATE OF invoice_id, workspace_id, organization_id ON invoice_lines FOR EACH ROW EXECUTE FUNCTION public.stella_invoice_client_guard();--> statement-breakpoint
CREATE TRIGGER workspaces_invoice_client_guard BEFORE UPDATE OF client_id ON workspaces FOR EACH ROW EXECUTE FUNCTION public.stella_invoice_client_guard();--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Replaces matter-only visibility with complete-invoice authorization.
DROP POLICY invoices_workspace_select ON invoices;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Replaces matter-only visibility with complete-invoice authorization.
DROP POLICY invoices_workspace_insert ON invoices;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Replaces matter-only visibility with complete-invoice authorization.
DROP POLICY invoices_workspace_update ON invoices;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Replaces matter-only visibility with complete-invoice authorization.
DROP POLICY invoices_workspace_delete ON invoices;--> statement-breakpoint
CREATE POLICY invoices_workspace_select ON invoices FOR SELECT TO stella USING (public.stella_invoice_access(id,organization_id,workspace_id,client_id,original_invoice_id));--> statement-breakpoint
CREATE POLICY invoices_workspace_insert ON invoices FOR INSERT TO stella WITH CHECK (public.stella_invoice_access(id,organization_id,workspace_id,client_id,original_invoice_id));--> statement-breakpoint
CREATE POLICY invoices_workspace_update ON invoices FOR UPDATE TO stella USING (public.stella_invoice_access(id,organization_id,workspace_id,client_id,original_invoice_id)) WITH CHECK (public.stella_invoice_access(id,organization_id,workspace_id,client_id,original_invoice_id));--> statement-breakpoint
CREATE POLICY invoices_workspace_delete ON invoices FOR DELETE TO stella USING (public.stella_invoice_access(id,organization_id,workspace_id,client_id,original_invoice_id));--> statement-breakpoint
CREATE POLICY invoice_lines_complete_invoice ON invoice_lines AS RESTRICTIVE FOR ALL TO stella USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_id));
--> statement-breakpoint
CREATE POLICY review_reset_owner_select ON invoices FOR SELECT USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoices'::regclass) AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY review_reset_owner_delete ON invoices FOR DELETE USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoices'::regclass) AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY invoice_lines_owner_select ON invoice_lines FOR SELECT USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_lines'::regclass));--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Returns only aggregate reserved charges for an authorized matter, never hidden invoice identifiers or other-matter data; fixed search path and tenant/actor authorization.
CREATE FUNCTION public.stella_matter_reserved_charges(matter_id uuid, invoice_currency text, excluded_invoice_id uuid)
RETURNS TABLE(amount numeric, mismatches bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM public.workspaces w WHERE w.id = matter_id
     AND w.organization_id = current_setting('app.organization_id',true)
     AND w.id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces)
 ) THEN
   RAISE EXCEPTION 'Matter billing access denied' USING ERRCODE = '42501';
 END IF;
 RETURN QUERY
 SELECT COALESCE(SUM(charges.net_amount) FILTER (WHERE charges.currency = invoice_currency),0),
   COUNT(*) FILTER (WHERE charges.currency <> invoice_currency)
 FROM (
   SELECT l.net_amount::numeric, i.currency
   FROM public.invoice_lines l JOIN public.invoices i ON i.id = l.invoice_id AND i.organization_id = l.organization_id
   JOIN public.workspaces w ON w.id = l.workspace_id AND w.organization_id = l.organization_id
   WHERE l.workspace_id = matter_id AND l.source = 'time_entry' AND l.released_at IS NULL
     AND i.status <> 'void' AND (excluded_invoice_id IS NULL OR i.id <> excluded_invoice_id)
   UNION ALL
   SELECT FLOOR((e.rate_at_entry::numeric * e.billed_minutes + 30) / 60), i.currency
   FROM public.time_entries e JOIN public.invoices i ON i.id = e.invoice_id AND i.organization_id = e.organization_id
   JOIN public.workspaces w ON w.id = e.workspace_id AND w.organization_id = e.organization_id
   WHERE e.workspace_id = matter_id AND e.activity_group = 'client' AND e.invoice_attachment = 'charged'
     AND i.status <> 'void' AND (excluded_invoice_id IS NULL OR i.id <> excluded_invoice_id)
     AND NOT EXISTS (SELECT 1 FROM public.invoice_lines l WHERE l.invoice_id = i.id AND l.time_entry_id = e.id AND l.source = 'time_entry' AND l.released_at IS NULL)
 ) charges;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_matter_reserved_charges(uuid,text,uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_matter_reserved_charges(uuid,text,uuid) TO stella;
--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Counts invoices only for an authorized tenant matter so hidden shared invoices still consume its resource quota; no invoice details are returned.
CREATE FUNCTION public.stella_matter_invoice_count(matter_id uuid) RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE invoice_count bigint;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = matter_id AND w.organization_id = current_setting('app.organization_id',true)
   AND w.id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces)) THEN
   RAISE EXCEPTION 'Matter billing access denied' USING ERRCODE = '42501';
 END IF;
 SELECT COUNT(*) INTO invoice_count FROM public.invoices i JOIN public.workspaces w ON w.id = matter_id AND w.organization_id = i.organization_id
 -- Resource reservations follow the linked original even before credit lines exist;
 -- list and export amounts still belong only to the credit note's own lines.
 WHERE i.workspace_id = matter_id OR EXISTS (SELECT 1 FROM public.invoice_lines l WHERE l.invoice_id = i.id AND l.workspace_id = matter_id)
 OR EXISTS (SELECT 1 FROM public.invoices original JOIN public.invoice_lines original_line ON original_line.invoice_id = original.id
   WHERE original.id = i.original_invoice_id AND original.organization_id = i.organization_id
     AND original.client_id IS NOT DISTINCT FROM i.client_id AND original.workspace_id IS NOT DISTINCT FROM i.workspace_id
     AND original_line.workspace_id = matter_id);
 RETURN invoice_count;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_matter_invoice_count(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_matter_invoice_count(uuid) TO stella;
