SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

-- An AI-extracted property (ai-model, playbook-verdict) can only ever hold
-- a value on a document, so its scope is derived, never chosen. The
-- application derives it on every write path, but during a rolling deploy an
-- older process may still insert or update a row with a null scope after the
-- one-shot backfill ran. This trigger makes the rule converge in the
-- database regardless of which writer runs: a null scope on an AI tool is
-- rewritten to documents before the row lands. Explicit scopes are left as
-- they are.
CREATE OR REPLACE FUNCTION "derive_property_kinds"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."kinds" IS NULL AND (NEW."tool"->>'type') IN ('ai-model', 'playbook-verdict') THEN
    NEW."kinds" := ARRAY['document']::varchar(64)[];
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "properties_derive_kinds"
BEFORE INSERT OR UPDATE OF "kinds", "tool" ON "properties"
FOR EACH ROW
EXECUTE FUNCTION "derive_property_kinds"();--> statement-breakpoint

-- Rows written between the first backfill and this trigger.
UPDATE "properties"
   SET "kinds" = ARRAY['document']::varchar(64)[]
 WHERE "kinds" IS NULL
   AND "tool"->>'type' IN ('ai-model', 'playbook-verdict');
