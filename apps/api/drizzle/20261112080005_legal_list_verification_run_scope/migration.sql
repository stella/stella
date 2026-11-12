SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- What a verification run checks: the whole document, or an inclusive range
-- of its paragraphs resolved when the run started. Runs started before carry
-- the whole document, which is what they checked.
--
-- The default is a constant, so the rewrite is metadata-only and no existing
-- row is read. The check only constrains the new column, so every existing
-- row already passes; it is validated online.
ALTER TABLE "legal_list_verification_runs"
  ADD COLUMN "scope" jsonb DEFAULT '{"kind":"whole"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_list_verification_runs" ADD CONSTRAINT "legal_list_verification_runs_scope_check"
  CHECK (CASE "scope"->>'kind'
    WHEN 'whole' THEN "scope" = '{"kind":"whole"}'::jsonb
    WHEN 'paragraphs' THEN CASE
      WHEN jsonb_typeof("scope"->'from') = 'number'
        AND jsonb_typeof("scope"->'to') = 'number'
        AND jsonb_typeof("scope"->'start'->'blockId') = 'string'
        AND jsonb_typeof("scope"->'start'->'offset') = 'number'
        AND jsonb_typeof("scope"->'end'->'blockId') = 'string'
        AND jsonb_typeof("scope"->'end'->'offset') = 'number'
        AND jsonb_typeof("scope"->'numbering') = 'string'
      THEN ("scope"->>'from')::numeric >= 1
        AND ("scope"->>'to')::numeric >= ("scope"->>'from')::numeric
        AND "scope"->>'numbering' IN ('document', 'ordinal')
      ELSE false END
    ELSE false END) NOT VALID;
