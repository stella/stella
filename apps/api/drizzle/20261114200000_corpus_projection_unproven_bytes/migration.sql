SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The NDJSON bytes a revision sends, recorded when its append starts, so an
-- index's appends that are started or accepted and not yet proven can be
-- held under a byte budget. A nullable column with no default, so no row is
-- rewritten. A writer of the previous release starts appends without it; the
-- budget counts such a row at the most its request could have carried.
ALTER TABLE "corpus_index_projection_intents" ADD COLUMN "append_bytes" integer;--> statement-breakpoint

-- The online phase builds corpus_index_projection_intents_unproven_idx (the
-- budget's sum, keyed like the prover's claim) concurrently.
