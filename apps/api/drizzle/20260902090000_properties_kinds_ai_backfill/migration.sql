SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

-- `properties.kinds` says which entity kinds a property applies to; NULL
-- means every kind. Every property written before this release left it NULL,
-- including `ai-model` and `playbook-verdict` columns, whose values only
-- extraction ever produces. Extraction only ever runs over documents (see
-- the `eq(entities.kind, "document")` filter in
-- apps/api/src/lib/document-review/table-run-create.ts), so those two tool
-- types can never hold a value on a task, message, link, or folder. Restrict
-- them to `{document}` retroactively so `kinds` matches what the write path
-- now derives for new and updated properties
-- (apps/api/src/lib/properties/property-kinds.ts). Rows already carrying a
-- non-NULL `kinds` are untouched: NULL is the only value that predates this
-- rule, so "already NULL" is exactly "never set".
UPDATE "properties"
   SET "kinds" = ARRAY['document']::varchar(64)[]
 WHERE "kinds" IS NULL
   AND "tool"->>'type' IN ('ai-model', 'playbook-verdict');
