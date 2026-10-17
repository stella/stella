-- requires: 20261016183000_eu_soft_law_statement_kind
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "soft_law_document_versions"
  ADD COLUMN "document_ast" jsonb,
  ADD COLUMN "ast_builder_version" integer,
  ADD CONSTRAINT "soft_law_versions_ast_check"
    CHECK (("ast_builder_version" IS NULL OR "ast_builder_version" > 0)
      AND ("document_ast" IS NULL OR "ast_builder_version" IS NOT NULL));
