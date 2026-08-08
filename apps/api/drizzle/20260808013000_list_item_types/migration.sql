SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Nullable for rollout compatibility: old API tasks omit this column, while
-- non-task entities must not be misclassified. New API tasks write it
-- explicitly and readers treat null task rows as the legacy "task" type.
ALTER TABLE "entities"
ADD COLUMN "list_item_type" text;

ALTER TABLE "entities"
ADD CONSTRAINT "entities_list_item_type_task_only"
CHECK (
  "list_item_type" IS NULL OR (
    "kind" = 'task' AND
    "list_item_type" IN ('task', 'fact', 'issue', 'requirement', 'event')
  )
) NOT VALID;--> statement-breakpoint
