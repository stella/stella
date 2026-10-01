SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- The index keeps only decisions that are still missing a document, so an
-- empty backlog probe never scans corpus-served rows.
SELECT set_config(
  'stella.migration_statement_timeout',
  current_setting('statement_timeout'),
  false
);
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- The migration runner validates this index and repairs an interrupted build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "case_law_decisions_document_outstanding_idx"
  ON "case_law_decisions" ("source_id", "id")
  WHERE "redacted_at" IS NULL
    AND "fulltext" IS NULL
    AND "document_url" IS NOT NULL
    AND (
      "content_hash" IS NULL
      OR "content_hash" IN (
        '38c18e8567ab7eb43737fbcb0b460cc715edc003359f072526757949857ba315'::text,
        'c21295bcba9c492b8fa6894ee2fcd6ca93b825ea61fc4965d00f41ea611071e2'::text,
        '528e88ac1a9fa9e94fdb3d8125ed6f216fd880cb2281c81c7bec5fa05d051361'::text,
        '6d30417783c39f6b9d8712cc0ea90d17cf7286e2733ad9c21fc845838ae66469'::text
      )
      OR "document_ast" IS NOT NULL
    );
--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
