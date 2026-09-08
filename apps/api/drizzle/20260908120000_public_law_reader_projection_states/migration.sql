SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The public read path decides from projection state whether a generation
-- built by the final projection holds a decision. The reader role gets the
-- columns that decision reads and nothing else: the applied revision, the
-- work schedule and the failure detail stay on the owning service side.
GRANT SELECT (
  family,
  generation,
  entity_id,
  desired_action,
  desired_epoch,
  desired_fingerprint,
  desired_index_id,
  applied_action,
  applied_epoch,
  applied_fingerprint,
  applied_index_id
) ON TABLE "corpus_index_projection_states" TO stella_public_law_reader;--> statement-breakpoint

CREATE POLICY "public_law_reader_access" ON "corpus_index_projection_states"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);
