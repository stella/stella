SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- One receipt per (organization, user, Idempotency-Key): the first create
-- request claims it, a repeat of that request replays the stored answer.
CREATE TABLE "request_idempotency_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "route" varchar(256) NOT NULL,
  "request_fingerprint" varchar(64) NOT NULL,
  "state" text NOT NULL,
  "response_status" integer,
  "response_body" jsonb,
  "claimed_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "request_idempotency_receipts_key_nonempty_check"
    CHECK (length("idempotency_key") > 0),
  CONSTRAINT "request_idempotency_receipts_fingerprint_check"
    CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "request_idempotency_receipts_state_check"
    CHECK (
      ("state" = 'pending' AND "response_status" IS NULL AND "completed_at" IS NULL)
      OR ("state" = 'completed' AND "response_status" IS NOT NULL AND "completed_at" IS NOT NULL)
    )
);--> statement-breakpoint
ALTER TABLE "request_idempotency_receipts"
  ADD CONSTRAINT "request_idempotency_receipts_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "request_idempotency_receipts"
  ADD CONSTRAINT "request_idempotency_receipts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "request_idempotency_receipts_org_user_key_uidx"
  ON "request_idempotency_receipts"
  ("organization_id", "user_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX "request_idempotency_receipts_claimed_at_idx"
  ON "request_idempotency_receipts" ("claimed_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "request_idempotency_receipts" TO stella;--> statement-breakpoint
ALTER TABLE "request_idempotency_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "request_idempotency_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- A receipt belongs to the member who sent the request, inside their organization.
CREATE POLICY "user_select" ON "request_idempotency_receipts" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "request_idempotency_receipts" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "request_idempotency_receipts" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "request_idempotency_receipts" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
-- Retention runs as the table owner across organizations and only removes
-- receipts past their replay window.
CREATE POLICY "retention_owner_select" ON "request_idempotency_receipts" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.request_idempotency_receipts'::regclass)
);--> statement-breakpoint
-- FOR UPDATE discovery needs UPDATE visibility, but the owner cannot rewrite
-- receipts without installing their organization and user scope.
CREATE POLICY "retention_owner_lock" ON "request_idempotency_receipts" FOR UPDATE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.request_idempotency_receipts'::regclass)
) WITH CHECK (false);--> statement-breakpoint

-- Review reset clears request results for every former organization member.
-- Only the table owner with the explicit reset organization can use this path.
CREATE POLICY "review_reset_owner_select" ON "request_idempotency_receipts" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.request_idempotency_receipts'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "request_idempotency_receipts" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.request_idempotency_receipts'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
