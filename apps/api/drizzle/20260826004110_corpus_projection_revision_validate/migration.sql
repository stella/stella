SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate outside the ADD transaction so the table scan does not inherit its
-- ACCESS EXCLUSIVE lock. The generation registry is bounded and currently
-- small; the timeout keeps that assumption explicit.
ALTER TABLE "corpus_index_generations"
  VALIDATE CONSTRAINT "corpus_index_generations_projection_revision_positive";
