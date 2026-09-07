SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The text a find-in-table reads from a cell, one expression the index and
-- the query share. Each findable content type stores its displayed string in
-- one place: `value` for text and single-select, `fileName` for a file,
-- `name` for a person. A multi-select's elements are read off the array's
-- JSON text with its two escapes undone (`\"` and `\\`), so a `"` or `\`
-- inside an element still matches a term that contains it; the brackets and
-- separators left between elements can only propose a row the query's
-- recheck then refuses. Every other type is NULL, so the function can never
-- widen what `buildFindConditions` matches.
--
-- The body must stay inlinable, or the trigram recheck calls the function
-- once per candidate row (five times the cost of the bare expression at 600k
-- cells): no subquery, aggregate or PL/pgSQL, and not STRICT, since the
-- planner will not inline a strict function around a non-strict CASE. The
-- column is NOT NULL, and a NULL argument falls out of the CASE as NULL
-- anyway. No case or diacritic folding: `ILIKE` under `gin_trgm_ops` is
-- already case-insensitive, and the browser marks the literal substring the
-- server matched, so a fold would mark nothing.
CREATE OR REPLACE FUNCTION field_find_text(content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE content->>'type'
    WHEN 'text' THEN content->>'value'
    WHEN 'single-select' THEN content->>'value'
    WHEN 'file' THEN content->>'fileName'
    WHEN 'person' THEN content->>'name'
    WHEN 'multi-select' THEN regexp_replace((content->'value')::text, '\\(["\\])', '\1', 'g')
  END
$$;
--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build
-- (which takes no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260901130000_legislation_title_fold.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

-- Drops only this migration's own index by name before recreating it. A
-- cancelled concurrent build leaves an INVALID index behind, and IF NOT
-- EXISTS would then skip recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "fields_find_text_trgm_idx";
--> statement-breakpoint
-- Substring matching over the cells a find can reach. Partial on the findable
-- types (the searchable half of FIELD_FIND_SUPPORT, bound by
-- fields-find-text-index.test.ts) so the AI workflow's pending and error
-- placeholders never enter the GIN pending list.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "fields_find_text_trgm_idx"
  ON "fields" USING gin (field_find_text("content") gin_trgm_ops)
  WHERE "content"->>'type' IN ('file', 'text', 'single-select', 'multi-select', 'person');
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
