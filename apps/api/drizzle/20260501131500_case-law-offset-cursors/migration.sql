UPDATE "case_law_sources"
SET "sync_cursor" = 'offset:' || (("sync_cursor"::bigint - 1) * 20)::text
WHERE "adapter_key" = 'at-courts'
  AND "sync_cursor" IS NOT NULL
  AND "sync_cursor" !~ '^offset:'
  AND "sync_cursor" ~ '^[0-9]+$'
  AND "sync_cursor"::bigint >= 1;--> statement-breakpoint
UPDATE "case_law_sources"
SET "sync_cursor" = 'offset:' || ("sync_cursor"::bigint * 100)::text
WHERE "adapter_key" = 'pl-courts'
  AND "sync_cursor" IS NOT NULL
  AND "sync_cursor" !~ '^offset:'
  AND "sync_cursor" ~ '^[0-9]+$';--> statement-breakpoint
UPDATE "case_law_sources"
SET "sync_cursor" = 'offset:' || ("sync_cursor"::bigint * 100)::text
WHERE "adapter_key" = 'sk-courts'
  AND "sync_cursor" IS NOT NULL
  AND "sync_cursor" !~ '^offset:'
  AND "sync_cursor" ~ '^[0-9]+$';
