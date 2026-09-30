-- requires: 20261003122800_time_entry_activity_groups
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
CREATE TABLE "billing_arrangements" (
 "workspace_id" uuid PRIMARY KEY,
 "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "mode" text NOT NULL,
 "currency" varchar(3) NOT NULL,
 "flat_fee_amount" bigint,
 "cap_amount" bigint,
 "alert_threshold_bps" integer,
 "threshold_state" text NOT NULL DEFAULT 'below',
 "cap_state" text NOT NULL DEFAULT 'below',
 "currency_state" text NOT NULL DEFAULT 'matched',
 "crossing_sequence" integer NOT NULL DEFAULT 0,
 "revision" integer NOT NULL DEFAULT 1,
 "updated_at" timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT "billing_arrangements_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE CASCADE,
 CONSTRAINT "billing_arrangements_mode_check" CHECK (
  (mode = 'flat_fee' AND flat_fee_amount IS NOT NULL AND flat_fee_amount >= 0 AND cap_amount IS NULL AND alert_threshold_bps IS NULL)
  OR (mode = 'hourly' AND flat_fee_amount IS NULL AND ((cap_amount IS NULL AND alert_threshold_bps IS NULL)
   OR (cap_amount IS NOT NULL AND alert_threshold_bps IS NOT NULL AND cap_amount > 0 AND alert_threshold_bps BETWEEN 1 AND 10000)))
 ),
 CONSTRAINT "billing_arrangements_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
 CONSTRAINT "billing_arrangements_amount_bounds_check" CHECK ((flat_fee_amount IS NULL OR flat_fee_amount <= 9007199254740991) AND (cap_amount IS NULL OR cap_amount <= 9007199254740991)),
 CONSTRAINT "billing_arrangements_crossing_check" CHECK (currency_state IN ('matched', 'mismatch') AND threshold_state IN ('below', 'above') AND cap_state IN ('below', 'above') AND crossing_sequence >= 0 AND revision > 0)
);
--> statement-breakpoint
ALTER TABLE "billing_arrangements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_arrangements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_arrangements" TO stella;
--> statement-breakpoint
CREATE POLICY "billing_arrangements_workspace_select"
  ON "billing_arrangements" AS PERMISSIVE FOR SELECT TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "billing_arrangements_workspace_insert"
  ON "billing_arrangements" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "billing_arrangements_workspace_update"
  ON "billing_arrangements" AS PERMISSIVE FOR UPDATE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "billing_arrangements_workspace_delete"
  ON "billing_arrangements" AS PERMISSIVE FOR DELETE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "rate_entries" ADD COLUMN "role" text;
--> statement-breakpoint
ALTER TABLE "rate_entries" ADD CONSTRAINT "rate_entries_exclusive_target_check" CHECK (user_id IS NULL OR role IS NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "rate_entries" ADD CONSTRAINT "rate_entries_role_check" CHECK (role IS NULL OR role IN ('owner','admin','member','intern','external')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "invoice_attachment" text NOT NULL DEFAULT 'charged';
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoice_attachment_check" CHECK (invoice_attachment IN ('charged', 'covered')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "billing_mode" text NOT NULL DEFAULT 'hourly';
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "flat_fee_amount" bigint;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billing_mode_check" CHECK (billing_mode IN ('hourly', 'flat_fee') AND ((billing_mode = 'hourly' AND flat_fee_amount IS NULL) OR (billing_mode = 'flat_fee' AND flat_fee_amount >= 0 AND flat_fee_amount IS NOT NULL))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "billing_purpose" text NOT NULL DEFAULT 'ordinary';
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_billing_purpose_check" CHECK (billing_purpose IN ('ordinary','flat_fee') AND (billing_purpose <> 'flat_fee' OR source = 'manual')) NOT VALID;
