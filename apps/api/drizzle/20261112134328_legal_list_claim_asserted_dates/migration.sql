-- requires: 20261112025400_legal_list_claim_carry_over
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A claim carries the date it asserts, in the shape a fact's date has: a day,
-- month or year stored as its first day. The source says where it came from
-- (the claim's words, or the grader when they name no complete date) or that
-- there is none.
--
-- The two date columns are nullable without a default and the source's
-- default is a constant, so adding them rewrites no row. Every stored claim
-- reads `pending` until the online backfill reads its words. The check only
-- constrains the new columns, so every existing row already passes; it is
-- added NOT VALID and validated online.
ALTER TABLE "legal_list_claims"
  ADD COLUMN "asserted_on" date,
  ADD COLUMN "asserted_on_precision" text,
  ADD COLUMN "asserted_on_source" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_list_claims" ADD CONSTRAINT "legal_list_claims_asserted_on_check"
  CHECK ("asserted_on_source" IN ('pending', 'none', 'text', 'grader')
    AND ("asserted_on" IS NULL) = ("asserted_on_precision" IS NULL)
    AND ("asserted_on" IS NOT NULL) = ("asserted_on_source" IN ('text', 'grader'))
    AND ("asserted_on_precision" IS NULL OR "asserted_on_precision" IN ('day', 'month', 'year'))
    AND ("asserted_on_precision" IS NULL OR "asserted_on_precision" = 'day'
      OR (extract(day from "asserted_on") = 1
        AND ("asserted_on_precision" = 'month' OR extract(month from "asserted_on") = 1)))) NOT VALID;--> statement-breakpoint

-- The backfill reads every workspace's claims as the table owner, as root
-- maintenance does on the run table.
CREATE POLICY "legal_list_claims_owner_access" ON "legal_list_claims"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_claims'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_claims'::regclass));

-- The pending-claims index (legal_list_claims_asserted_on_pending_idx) is
-- built concurrently in the online phase, before the backfill reads it.
