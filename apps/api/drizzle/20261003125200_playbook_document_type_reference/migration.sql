-- requires: 20260630120000_document_types
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
-- A plain nullable column is a catalog-only change. The trigger below derives
-- it from scope for every writer, so it always equals the scope's key.
ALTER TABLE "playbook_definitions" ADD COLUMN "document_type_key" text;
--> statement-breakpoint
CREATE FUNCTION "derive_playbook_definition_document_type_key"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW."document_type_key" := NEW."scope"->>'documentTypeKey';
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "playbook_definitions_derive_document_type_key"
  BEFORE INSERT OR UPDATE ON "playbook_definitions"
  FOR EACH ROW
  EXECUTE FUNCTION "derive_playbook_definition_document_type_key"();
--> statement-breakpoint
-- Existing scoped definitions take their key in this transaction, before the
-- reference exists, so validation checks them later. Only scoped rows are
-- written; the statement timeout bounds the update.
UPDATE "playbook_definitions"
  SET "document_type_key" = "scope"->>'documentTypeKey'
  WHERE "scope"->>'documentTypeKey' IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "playbook_definitions" ADD CONSTRAINT "playbook_definitions_document_type_fk"
  FOREIGN KEY ("organization_id", "document_type_key")
  REFERENCES "document_types" ("organization_id", "key") NOT VALID;
