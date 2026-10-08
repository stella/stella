-- requires: 20260925220000_legal_list_verifications
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "legal_list_verification_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_verification_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_claims" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_claim_review_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_claim_review_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Reaffirm the request role's existing privileges alongside the RLS changes.
-- Review history retains its restrictive update/delete policies.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "legal_list_verification_runs", "legal_list_claims", "legal_list_claim_review_events"
  TO stella;--> statement-breakpoint

-- Root maintenance scans queued runs and closes stale runs across matters.
CREATE POLICY "legal_list_verification_runs_owner_access"
  ON "legal_list_verification_runs" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_verification_runs'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_verification_runs'::regclass));
