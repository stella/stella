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
-- stella-migration-safety: reviewed security-definer - Returns only reserved billable minutes for a tenant-authorized matter; fixed search path and actor authorization prevent access to hidden invoice details.
CREATE FUNCTION public.stella_matter_reserved_minutes(matter_id uuid, excluded_invoice_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE minutes bigint;
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.workspaces w WHERE w.id = matter_id
   AND w.organization_id = current_setting('app.organization_id',true)
   AND w.id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces)
 ) THEN
  RAISE EXCEPTION 'Matter billing access denied' USING ERRCODE = '42501';
 END IF;
 SELECT COALESCE(SUM(reservations.minutes),0)::bigint INTO minutes FROM (
  SELECT ROUND(l.quantity * 60)::bigint AS minutes
  FROM public.invoice_lines l JOIN public.invoices i ON i.id = l.invoice_id AND i.organization_id = l.organization_id
  JOIN public.workspaces w ON w.id = l.workspace_id AND w.organization_id = l.organization_id
  WHERE l.workspace_id = matter_id AND l.source = 'time_entry' AND l.released_at IS NULL
   AND i.status <> 'void' AND i.original_invoice_id IS NULL
   AND (excluded_invoice_id IS NULL OR i.id <> excluded_invoice_id)
  UNION ALL
  SELECT e.billed_minutes::bigint
  FROM public.time_entries e JOIN public.invoices i ON i.id = e.invoice_id AND i.organization_id = e.organization_id
  JOIN public.workspaces w ON w.id = e.workspace_id AND w.organization_id = e.organization_id
  WHERE e.workspace_id = matter_id AND e.activity_group = 'client' AND e.invoice_attachment = 'charged'
   AND i.status <> 'void' AND i.original_invoice_id IS NULL
   AND (excluded_invoice_id IS NULL OR i.id <> excluded_invoice_id)
   AND NOT EXISTS (SELECT 1 FROM public.invoice_lines l WHERE l.invoice_id = i.id AND l.time_entry_id = e.id AND l.source = 'time_entry' AND l.released_at IS NULL)
 ) reservations;
 RETURN minutes;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_matter_reserved_minutes(uuid,uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_matter_reserved_minutes(uuid,uuid) TO stella;
