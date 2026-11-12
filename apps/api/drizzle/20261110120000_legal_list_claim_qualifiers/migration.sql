SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Caveats the grader gives with a claim's verdict: a record that is not
-- expected to speak to the point, or a fact about a different scope than the
-- claim. Claims graded before carry none.
--
-- The default is a constant, so the rewrite is metadata-only and no existing
-- row is read. The check only constrains the new column, so every existing
-- row already passes; it is validated online.
ALTER TABLE "legal_list_claims"
  ADD COLUMN "qualifiers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_list_claims" ADD CONSTRAINT "legal_list_claims_qualifiers_check"
  CHECK (jsonb_typeof("qualifiers") = 'array'
    AND ("state" = 'nocover'
      OR NOT "qualifiers" @> jsonb_build_array(jsonb_build_object('kind', 'record-silent')))) NOT VALID;
