SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Existing rows stay NULL: their pending age falls back to created_at and is
-- reported as such, instead of being restamped with this migration's time.
ALTER TABLE "corpus_index_projection_states"
  ADD COLUMN IF NOT EXISTS "desired_at" timestamptz;--> statement-breakpoint
ALTER TABLE "corpus_index_projection_states"
  ALTER COLUMN "desired_at" SET DEFAULT now();
