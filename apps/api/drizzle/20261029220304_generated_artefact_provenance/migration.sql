SET lock_timeout = '5s';
SET statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE chat_threads ADD COLUMN generation_provenance jsonb;
--> statement-breakpoint
ALTER TABLE chat_threads ADD CONSTRAINT chat_threads_generation_provenance_valid
CHECK (generation_provenance IS NULL OR generation_provenance = 'null'::jsonb OR coalesce(
  jsonb_typeof(generation_provenance) = 'object'
  AND generation_provenance - ARRAY['version', 'slots']::text[] = '{}'::jsonb
  AND generation_provenance->'version' = '1'::jsonb
  AND jsonb_typeof(generation_provenance->'slots') = 'object'
  AND NOT jsonb_path_exists(generation_provenance, '$.slots.keyvalue() ? (@.key == "")')
  AND NOT jsonb_path_exists(generation_provenance, 'strict $.slots.* ? (@.type() != "object")', '{}'::jsonb, true)
  AND NOT jsonb_path_exists(generation_provenance, '$.slots.* ? (@.type() != "object" || !exists(@.type) || @.type.type() != "string" || (@.type != "authored" && @.type != "generated"))')
  AND NOT jsonb_path_exists(generation_provenance, '$.slots.* ? (@.type == "authored").keyvalue() ? (@.key != "type")')
  AND NOT jsonb_path_exists(generation_provenance, '$.slots.* ? (@.type == "generated").keyvalue() ? (@.key != "type" && @.key != "generator" && @.key != "decisionIds" && @.key != "coverage")')
  AND NOT jsonb_path_exists(generation_provenance, '$.slots.* ? (@.type == "generated" && (!exists(@.generator) || @.generator.type() != "string" || @.generator == "" || !exists(@.decisionIds) || @.decisionIds.type() != "array" || @.decisionIds.size() > 1024 || !exists(@.coverage) || @.coverage.type() != "string" || (@.coverage != "complete" && @.coverage != "legacy-input")))')
  AND NOT jsonb_path_exists(generation_provenance, 'strict $.slots.* ? (@.type == "generated").decisionIds[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"))', '{}'::jsonb, true),
  false)) NOT VALID;
--> statement-breakpoint
GRANT SELECT (generation_provenance), UPDATE (generation_provenance), INSERT (generation_provenance) ON chat_threads TO stella;
