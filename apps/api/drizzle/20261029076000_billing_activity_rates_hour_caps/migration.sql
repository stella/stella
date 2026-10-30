SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE rate_entries ADD COLUMN activity_code_id uuid;--> statement-breakpoint
ALTER TABLE rate_entries ADD CONSTRAINT rate_entries_activity_code_id_billing_codes_id_fk FOREIGN KEY (activity_code_id) REFERENCES billing_codes(id) ON DELETE NO ACTION NOT VALID;--> statement-breakpoint
ALTER TABLE billing_arrangements ADD COLUMN cap_minutes integer;--> statement-breakpoint
ALTER TABLE billing_arrangements ADD COLUMN minute_threshold_state text DEFAULT 'below';--> statement-breakpoint
ALTER TABLE billing_arrangements ADD COLUMN minute_cap_state text DEFAULT 'below';--> statement-breakpoint
ALTER TABLE billing_arrangements ADD CONSTRAINT billing_arrangements_mode_caps_check CHECK (
 (mode = 'flat_fee' AND flat_fee_amount IS NOT NULL AND flat_fee_amount >= 0 AND cap_amount IS NULL AND cap_minutes IS NULL AND alert_threshold_bps IS NULL)
 OR (mode = 'hourly' AND flat_fee_amount IS NULL AND (
  (cap_amount IS NULL AND cap_minutes IS NULL AND alert_threshold_bps IS NULL)
  OR ((cap_amount IS NOT NULL OR cap_minutes IS NOT NULL)
    AND (cap_amount IS NULL OR cap_amount > 0) AND (cap_minutes IS NULL OR cap_minutes > 0)
    AND alert_threshold_bps IS NOT NULL AND alert_threshold_bps BETWEEN 1 AND 10000)
 ))) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - The replacement mode_caps check is already installed and retains all existing-row invariants while admitting hourly minute caps.
ALTER TABLE billing_arrangements DROP CONSTRAINT billing_arrangements_mode_check;--> statement-breakpoint
ALTER TABLE billing_arrangements ADD CONSTRAINT billing_arrangements_minute_crossing_check CHECK (
 (minute_threshold_state IS NULL OR minute_threshold_state IN ('below','above'))
 AND (minute_cap_state IS NULL OR minute_cap_state IN ('below','above'))
) NOT VALID;--> statement-breakpoint
-- Active time-entry lines must retain their source entry (invoice_lines_source_reference_check).
-- Classify the source once so line snapshots and legacy attachments share both cap measures.
-- stella-migration-safety: reviewed security-definer - The private aggregate owner authorizes the tenant matter before reading charges, exposes no invoice identifiers, and is called only by the existing aggregate wrappers with a fixed search path.
CREATE FUNCTION public.stella_matter_reserved_time(matter_id uuid, invoice_currency text, excluded_invoice_id uuid)
RETURNS TABLE(amount numeric, mismatches bigint, minutes bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.workspaces w WHERE w.id = matter_id
   AND w.organization_id = current_setting('app.organization_id',true)
   AND w.id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces)
 ) THEN
  RAISE EXCEPTION 'Matter billing access denied' USING ERRCODE = '42501';
 END IF;
 RETURN QUERY
 WITH charged_time AS MATERIALIZED (
  SELECT e.id, e.invoice_id, e.organization_id, e.workspace_id,
   e.rate_at_entry, e.billed_minutes, i.currency
  FROM public.time_entries e
  JOIN public.invoices i ON i.id = e.invoice_id AND i.organization_id = e.organization_id
  JOIN public.workspaces w ON w.id = e.workspace_id AND w.organization_id = e.organization_id
  WHERE e.workspace_id = matter_id AND e.activity_group = 'client' AND e.invoice_attachment = 'charged'
   AND i.status <> 'void' AND i.original_invoice_id IS NULL
   AND (excluded_invoice_id IS NULL OR i.id <> excluded_invoice_id)
 ), charges AS (
  SELECT l.net_amount::numeric AS net_amount, t.currency, ROUND(l.quantity * 60)::bigint AS minutes
  FROM charged_time t JOIN public.invoice_lines l
   ON l.time_entry_id = t.id AND l.invoice_id = t.invoice_id
   AND l.organization_id = t.organization_id AND l.workspace_id = t.workspace_id
  WHERE l.source = 'time_entry' AND l.released_at IS NULL
  UNION ALL
  SELECT FLOOR((t.rate_at_entry::numeric * t.billed_minutes + 30) / 60), t.currency, t.billed_minutes::bigint
  FROM charged_time t
  WHERE NOT EXISTS (
   SELECT 1 FROM public.invoice_lines l
   WHERE l.invoice_id = t.invoice_id AND l.time_entry_id = t.id
    AND l.source = 'time_entry' AND l.released_at IS NULL
  )
 )
 SELECT COALESCE(SUM(charges.net_amount) FILTER (WHERE charges.currency = invoice_currency),0),
  COUNT(*) FILTER (WHERE charges.currency <> invoice_currency),
  COALESCE(SUM(charges.minutes),0)::bigint
 FROM charges;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_matter_reserved_time(uuid,text,uuid) FROM PUBLIC;--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Preserves the authorized aggregate-only amount interface and its existing ACL while delegating charged-time classification to the private tenant-authorizing owner.
CREATE OR REPLACE FUNCTION public.stella_matter_reserved_charges(matter_id uuid, invoice_currency text, excluded_invoice_id uuid)
RETURNS TABLE(amount numeric, mismatches bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT usage.amount, usage.mismatches
 FROM public.stella_matter_reserved_time(matter_id, invoice_currency, excluded_invoice_id) usage;
$$;--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Returns only the minute aggregate from the private tenant-authorizing charged-time owner and retains the fixed search path and aggregate-only application grant.
CREATE FUNCTION public.stella_matter_reserved_minutes(matter_id uuid, excluded_invoice_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT usage.minutes
 FROM public.stella_matter_reserved_time(matter_id, NULL::text, excluded_invoice_id) usage;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_matter_reserved_minutes(uuid,uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_matter_reserved_minutes(uuid,uuid) TO stella;
