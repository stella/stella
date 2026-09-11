SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The cluster check was added NOT VALID by the previous migration, which also
-- deleted the only rows that could fail it. Validating here, in its own
-- transaction, takes a SHARE UPDATE EXCLUSIVE lock instead of blocking reads
-- for the length of the scan.
ALTER TABLE "corpus_index_generations"
  VALIDATE CONSTRAINT "corpus_index_generations_cluster_values";
