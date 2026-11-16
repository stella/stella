SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Each run's output key, random per run and encrypted for its organization,
-- with its IV. The API sends the key to the computer in `run.start` and signs
-- every grant to read the run's step outputs with it, so grants stay valid
-- for the life of the run whatever else the deployment rotates. Nullable, no
-- default: the columns are added in the catalog without rewriting a row, and
-- a run assigned before them keeps no key.
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "output_key_encrypted" bytea;--> statement-breakpoint
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "output_key_iv" bytea;
