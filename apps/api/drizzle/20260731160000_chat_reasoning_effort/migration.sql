ALTER TABLE "chat_threads"
ADD COLUMN "chat_reasoning_effort" text;

ALTER TABLE "chat_threads"
ADD CONSTRAINT "chat_threads_reasoning_effort_selection_check"
CHECK (
  "chat_reasoning_effort" IS NULL
  OR (
    "chat_model" IS NOT NULL
    AND "chat_reasoning_effort" IN (
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    )
  )
);
