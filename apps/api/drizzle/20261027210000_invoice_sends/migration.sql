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
ALTER TABLE "invoice_sends" ADD CONSTRAINT "invoice_sends_invoice_organization_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "invoices"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
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
-- belongs to is found here and everything after runs under row policies in
-- that tenant's scope. The lookup answers only for the exact hash of a live
-- link (not revoked, not expired, delivered, on an issued invoice that is not
-- void, with its sender still on record): it cannot list, and it returns the
-- tenant's ids and the invoice's matters, never a send's contents.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked and granted to the app role only; it writes nothing and returns only the tenant scope of the one live invoice link whose token hash the caller holds
CREATE FUNCTION "invoice_link_scope"(p_token_hash text)
RETURNS TABLE (send_id uuid, organization_id text, user_id text, invoice_id uuid, workspace_ids uuid[])
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
                   OR l.invoice_id = i.original_invoice_id
             ) matter
            ORDER BY matter.workspace_id
         )
    FROM public.invoice_sends s
    JOIN public.invoices i
      ON i.id = s.invoice_id AND i.organization_id = s.organization_id
   WHERE s.token_hash = p_token_hash
     AND s.sent_by_user_id IS NOT NULL
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
