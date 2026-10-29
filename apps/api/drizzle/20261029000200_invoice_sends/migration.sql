-- Invoices sent by email as a secure link. Additive: a nullable reply-to
-- address on seller profiles, and a new table holding each send, its
-- recipients and the SHA-256 of the link token the email carried.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "email" varchar(320);--> statement-breakpoint
CREATE TABLE "invoice_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"invoice_id" uuid NOT NULL,
	"sent_by_user_id" text,
	"recipients" text[] NOT NULL,
	"failed_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"message" text,
	"language" text NOT NULL,
	"reply_to" varchar(320) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"revoked_at" timestamptz,
	"revoked_by_user_id" text,
	"first_viewed_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_sends_delivery_status_check" CHECK ("invoice_sends"."delivery_status" in ('pending', 'delivered', 'partial', 'failed')),
	CONSTRAINT "invoice_sends_language_check" CHECK ("invoice_sends"."language" IN ('ar', 'cs', 'de', 'en', 'es', 'et', 'fr', 'hu', 'lt', 'lv', 'pl', 'pt-BR', 'sk')),
	CONSTRAINT "invoice_sends_recipients_check" CHECK (cardinality("invoice_sends"."recipients") BETWEEN 1 AND 10 AND "invoice_sends"."failed_recipients" <@ "invoice_sends"."recipients"),
	CONSTRAINT "invoice_sends_message_check" CHECK ("invoice_sends"."message" IS NULL OR length("invoice_sends"."message") BETWEEN 1 AND 2000),
	CONSTRAINT "invoice_sends_revoked_check" CHECK ("invoice_sends"."revoked_by_user_id" IS NULL OR "invoice_sends"."revoked_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "invoice_sends" ADD CONSTRAINT "invoice_sends_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
-- A send goes with its invoice: deleting the invoice (a draft, or the review
-- reset's billing stage) removes its delivery history in the same statement.
-- The invoice tenant key is installed by the later online phase. Row security
-- and token-scoped joins enforce the organization boundary.
ALTER TABLE "invoice_sends" ADD CONSTRAINT "invoice_sends_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE;--> statement-breakpoint
-- The history outlives the people in it: a deleted account leaves a null.
ALTER TABLE "invoice_sends" ADD CONSTRAINT "invoice_sends_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "invoice_sends" ADD CONSTRAINT "invoice_sends_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_sends_token_hash_uidx" ON "invoice_sends" ("token_hash");--> statement-breakpoint
CREATE INDEX "invoice_sends_invoice_created_idx" ON "invoice_sends" ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_sends_org_created_idx" ON "invoice_sends" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_sends_sent_by_idx" ON "invoice_sends" ("sent_by_user_id") WHERE "invoice_sends"."sent_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "invoice_sends_revoked_by_idx" ON "invoice_sends" ("revoked_by_user_id") WHERE "invoice_sends"."revoked_by_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Forced, so the owner login is held to policies too. It only reads a send,
-- inside the token lookup below; it never writes one.
ALTER TABLE "invoice_sends" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "invoice_sends" TO stella;--> statement-breakpoint
CREATE POLICY "invoice_sends_organization_select" ON "invoice_sends" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "invoice_sends_organization_insert" ON "invoice_sends" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "invoice_sends_organization_update" ON "invoice_sends" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))) WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
-- A send is visible exactly when its invoice is: the subquery reads
-- invoices under their own row security.
CREATE POLICY "invoice_sends_complete_invoice" ON "invoice_sends" AS RESTRICTIVE FOR ALL TO "stella" USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = "invoice_sends"."invoice_id")) WITH CHECK (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = "invoice_sends"."invoice_id"));--> statement-breakpoint
-- The owner is named by the catalog rather than by role: its login name
-- differs from one deployment to the next.
CREATE POLICY "invoice_sends_owner_select" ON "invoice_sends" AS PERMISSIVE FOR SELECT TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_sends'::regclass));--> statement-breakpoint
-- An invoice link carries a token, not a session, so the tenant a token
-- belongs to is found here. Document projections recheck the same hash;
-- audited side effects run in that tenant's service scope. The lookup answers
-- only for the exact hash of a live
-- link (not revoked, not expired, delivered, on an issued invoice that is not
-- void, independently of its sending member): it cannot list, and it returns the
-- tenant's ids and the invoice's matters, never a send's contents.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked and granted to the app role only; it writes nothing and returns only the tenant scope of the one live invoice link whose token hash the caller holds
CREATE FUNCTION "invoice_link_scope"(p_token_hash text)
RETURNS TABLE (send_id uuid, organization_id text, user_id text, invoice_id uuid, workspace_ids uuid[], expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.organization_id::text, s.sent_by_user_id, s.invoice_id,
         ARRAY(
           SELECT DISTINCT matter.workspace_id
             FROM (
               SELECT i.workspace_id
                WHERE i.workspace_id IS NOT NULL
               UNION
               SELECT l.workspace_id
                 FROM public.invoice_lines l
                WHERE l.invoice_id = i.id
             ) matter
            ORDER BY matter.workspace_id
         ), s.expires_at
    FROM public.invoice_sends s
    JOIN public.invoices i
      ON i.id = s.invoice_id AND i.organization_id = s.organization_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > pg_catalog.now()
     AND s.delivery_status IN ('delivered', 'partial')
     AND i.status IN ('finalized', 'sent', 'paid')
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_scope"(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_scope"(text) TO stella;
--> statement-breakpoint
-- The organization-wide send limit counts every send of the caller's own
-- organization, including those on matters the caller cannot read. The
-- organization comes from the transaction's own scope, never from an
-- argument, so the count is only ever of the caller's organization.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked and granted to the app role only; it writes nothing and returns only how many invoice sends the transaction's own organization made since a time
CREATE FUNCTION "invoice_sends_organization_count"(p_since timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
    FROM public.invoice_sends s
   WHERE s.organization_id = NULLIF(pg_catalog.current_setting('app.organization_id', true), '')
     AND s.created_at > p_since
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_sends_organization_count"(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_sends_organization_count"(timestamptz) TO stella;

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; the live token hash authorizes only this invoice's document projection
CREATE FUNCTION "invoice_link_invoice"(p_token_hash text)
RETURNS TABLE ("id" uuid, "organization_id" varchar(128), "workspace_id" uuid, "client_id" uuid, "seller_profile_id" uuid, "original_invoice_id" uuid, "status" text, "document_type" text, "invoice_number" varchar(64), "invoice_date" date, "due_date" date, "taxable_supply_date" date, "currency" varchar(3), "language" text, "reference" varchar(256), "notes" text, "vat_exchange_rate" numeric(24, 12), "vat_exchange_rate_source" varchar(8), "vat_exchange_rate_date" date, "vat_exchange_rate_reference" varchar(64), "vat_exchange_rate_tax_point" date, "buyer_name" varchar(512), "buyer_registration_id" varchar(64), "buyer_tax_id" varchar(64), "buyer_vat_id" varchar(64), "buyer_address_line_1" varchar(512), "buyer_address_line_2" varchar(512), "buyer_city" varchar(256), "buyer_postal_code" varchar(32), "buyer_country" varchar(128), "net_amount" bigint, "total_amount" bigint, "paid_at" timestamp with time zone)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT r."id", r."organization_id", r."workspace_id", r."client_id", r."seller_profile_id", r."original_invoice_id", r."status", r."document_type", r."invoice_number", r."invoice_date", r."due_date", r."taxable_supply_date", r."currency", r."language", r."reference", r."notes", r."vat_exchange_rate", r."vat_exchange_rate_source", r."vat_exchange_rate_date", r."vat_exchange_rate_reference", r."vat_exchange_rate_tax_point", r."buyer_name", r."buyer_registration_id", r."buyer_tax_id", r."buyer_vat_id", r."buyer_address_line_1", r."buyer_address_line_2", r."buyer_city", r."buyer_postal_code", r."buyer_country", r."net_amount", r."total_amount", r."paid_at" FROM public.invoices r JOIN public.invoice_link_scope(p_token_hash) s ON r.id = s.invoice_id AND r.organization_id = s.organization_id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_invoice"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_invoice"(text) TO stella;

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; the live token hash authorizes only this invoice's document projection
CREATE FUNCTION "invoice_link_lines"(p_token_hash text)
RETURNS TABLE ("id" uuid, "workspace_id" uuid, "billing_purpose" text, "position" integer, "description" text, "recorded_description" text, "recorded_quantity" numeric(18, 4), "recorded_unit" varchar(32), "recorded_unit_price" bigint, "recorded_net_amount" bigint, "quantity" numeric(18, 4), "unit" varchar(32), "unit_price" bigint, "vat_rate_bps" integer, "vat_treatment" text, "exemption_reason" text, "net_amount" bigint, "vat_amount" bigint, "gross_amount" bigint, "source" text, "time_entry_id" uuid, "expense_id" uuid, "released_at" timestamp with time zone)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT r."id", r."workspace_id", r."billing_purpose", r."position", r."description", r."recorded_description", r."recorded_quantity", r."recorded_unit", r."recorded_unit_price", r."recorded_net_amount", r."quantity", r."unit", r."unit_price", r."vat_rate_bps", r."vat_treatment", r."exemption_reason", r."net_amount", r."vat_amount", r."gross_amount", r."source", r."time_entry_id", r."expense_id", r."released_at" FROM public.invoice_lines r JOIN public.invoice_link_scope(p_token_hash) s ON r.invoice_id = s.invoice_id AND r.organization_id = s.organization_id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_lines"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_lines"(text) TO stella;

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; the live token hash authorizes only this invoice's document projection
CREATE FUNCTION "invoice_link_time"(p_token_hash text)
RETURNS TABLE ("id" uuid, "workspace_id" uuid, "date_worked" date, "billed_minutes" integer, "rate_at_entry" bigint, "currency" varchar(3), "narrative" text, "invoice_narrative" text, "no_charge" boolean, "status" text, "invoice_attachment" text, "user_id" text, "task_code" varchar(20), "activity_code" varchar(20))
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT r."id", r."workspace_id", r."date_worked", r."billed_minutes", r."rate_at_entry", r."currency", r."narrative", r."invoice_narrative", r."no_charge", r."status", r."invoice_attachment", r."user_id", r."task_code", r."activity_code" FROM public.time_entries r JOIN public.invoice_link_scope(p_token_hash) s ON r.invoice_id = s.invoice_id AND r.organization_id = s.organization_id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_time"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_time"(text) TO stella;

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; the live token hash authorizes only this invoice's document projection
CREATE FUNCTION "invoice_link_expenses"(p_token_hash text)
RETURNS TABLE ("id" uuid, "workspace_id" uuid, "date_incurred" date, "amount" bigint, "currency" varchar(3), "category" text, "description" text, "invoice_description" text, "billable" boolean, "markup" integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT r."id", r."workspace_id", r."date_incurred", r."amount", r."currency", r."category", r."description", r."invoice_description", r."billable", r."markup" FROM public.expenses r JOIN public.invoice_link_scope(p_token_hash) s ON r.invoice_id = s.invoice_id AND r.organization_id = s.organization_id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_expenses"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_expenses"(text) TO stella;

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; the live token hash authorizes only this invoice's document projection
CREATE FUNCTION "invoice_link_seller"(p_token_hash text)
RETURNS TABLE ("id" uuid, "legal_name" varchar(512), "registration_id" varchar(64), "tax_id" varchar(64), "vat_id" varchar(64), "register_entry" text, "bar_registration" text, "vat_payer" boolean, "address_line_1" varchar(512), "address_line_2" varchar(512), "city" varchar(256), "postal_code" varchar(32), "country" varchar(128), "iban" varchar(34), "bic" varchar(11), "account_number" varchar(64), "default_currency" varchar(3), "footer_notes" text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT r."id", r."legal_name", r."registration_id", r."tax_id", r."vat_id", r."register_entry", r."bar_registration", r."vat_payer", r."address_line_1", r."address_line_2", r."city", r."postal_code", r."country", r."iban", r."bic", r."account_number", r."default_currency", r."footer_notes" FROM public.seller_profiles r JOIN public.invoices i ON r.id = i.seller_profile_id AND r.organization_id = i.organization_id JOIN public.invoice_link_scope(p_token_hash) s ON i.id = s.invoice_id AND i.organization_id = s.organization_id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_seller"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_seller"(text) TO stella;

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; the live token hash authorizes only this invoice's document projection
CREATE FUNCTION "invoice_link_matters"(p_token_hash text)
RETURNS TABLE ("id" uuid, "name" varchar(256), "reference" varchar(64), "color" varchar(32))
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT r."id", r."name", r."reference", r."color" FROM public.workspaces r JOIN public.invoice_link_scope(p_token_hash) s ON r.id = ANY(s.workspace_ids) AND r.organization_id = s.organization_id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_matters"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_matters"(text) TO stella;

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; the live token hash authorizes only this invoice's document projection
CREATE FUNCTION "invoice_link_original"(p_token_hash text)
RETURNS TABLE ("id" uuid, "invoice_number" varchar(64), "invoice_date" date)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT r."id", r."invoice_number", r."invoice_date" FROM public.invoices r JOIN public.invoices i ON r.id = i.original_invoice_id AND r.organization_id = i.organization_id JOIN public.invoice_link_scope(p_token_hash) s ON i.id = s.invoice_id AND i.organization_id = s.organization_id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_original"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_original"(text) TO stella;

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; rechecks token, organization, revocation, expiry and invoice state while stamping access, returning whether delivery is permitted
CREATE FUNCTION "invoice_link_mark_viewed"(p_token_hash text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_live boolean;
BEGIN
  PERFORM pg_catalog.set_config('app.invoice_link_hash', p_token_hash, true);
  UPDATE public.invoice_sends s SET first_viewed_at = COALESCE(s.first_viewed_at, pg_catalog.clock_timestamp())
  FROM public.invoice_link_scope(p_token_hash) live
  WHERE s.id = live.send_id
    AND s.organization_id = live.organization_id
    AND s.organization_id = NULLIF(pg_catalog.current_setting('app.organization_id', true), '')
    AND s.revoked_at IS NULL
    AND s.expires_at > pg_catalog.clock_timestamp();
  v_live := FOUND;
  PERFORM pg_catalog.set_config('app.invoice_link_hash', '', true);
  RETURN v_live;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_mark_viewed"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_mark_viewed"(text) TO stella;

--> statement-breakpoint
-- The forced-RLS owner can stamp only the exact hash installed by the
-- definer function; the application role receives no additional policy.
CREATE POLICY "invoice_sends_owner_viewed" ON "invoice_sends" AS PERMISSIVE FOR UPDATE TO public
USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_sends'::regclass)
  AND token_hash = NULLIF(pg_catalog.current_setting('app.invoice_link_hash', true), ''))
WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_sends'::regclass)
  AND token_hash = NULLIF(pg_catalog.current_setting('app.invoice_link_hash', true), ''));

--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path and app-only execute; only a live token in its organization can read scalar paid totals and the settlement date, never payment rows or actor data
CREATE FUNCTION "invoice_link_settlement"(p_token_hash text)
RETURNS TABLE ("latest_paid_on" date, "paid_amount" bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN i.status = 'paid' THEN max(p.paid_on) ELSE NULL END, COALESCE(sum(p.amount), 0)::bigint
    FROM public.invoice_link_scope(p_token_hash) s
    JOIN public.invoices i ON i.id = s.invoice_id AND i.organization_id = s.organization_id
    LEFT JOIN public.invoice_payments p ON p.invoice_id = i.id AND p.organization_id = i.organization_id AND p.voided_at IS NULL
   WHERE s.organization_id = NULLIF(pg_catalog.current_setting('app.organization_id', true), '')
   GROUP BY i.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "invoice_link_settlement"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "invoice_link_settlement"(text) TO stella;
