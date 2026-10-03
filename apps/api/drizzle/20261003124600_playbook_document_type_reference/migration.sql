-- requires: 20260630120000_document_types
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
-- The stored key is derived from scope for every writer. The rewrite is
-- bounded by the statement timeout; a timeout rolls the migration back.
-- squawk-ignore adding-field-with-default
ALTER TABLE "playbook_definitions" ADD COLUMN "document_type_key" text
  GENERATED ALWAYS AS ("scope"->>'documentTypeKey') STORED;
--> statement-breakpoint
ALTER TABLE "playbook_definitions" ADD CONSTRAINT "playbook_definitions_document_type_fk"
  FOREIGN KEY ("organization_id", "document_type_key")
  REFERENCES "document_types" ("organization_id", "key") NOT VALID;
