SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "database_backfill_states" (
  "name" text PRIMARY KEY NOT NULL,
  "cursor" text,
  "batch" jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "database_backfill_states" ENABLE ROW LEVEL SECURITY;
