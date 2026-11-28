SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- How many revisions an entity's next append may share a request with. A
-- shared append that fails without saying which revision failed halves it,
-- instead of isolating every revision of the request into requests of its
-- own (`append_mode = 'single'`).
--
-- Only adds: a column with a constant default (catalog-only, no rewrite) and
-- its value check, NOT VALID, validated by its own online entry. Every
-- existing row reads the default, which passes the check. The retired
-- `append_mode` column stays for the previous release's writers; the new
-- release reads a row it still marks `single` as a cap of 32.
ALTER TABLE "corpus_index_projection_states"
  ADD COLUMN "append_request_cap" integer NOT NULL DEFAULT 512,
  ADD CONSTRAINT "corpus_index_projection_states_append_request_cap_values"
    CHECK ("append_request_cap" IN (1, 2, 4, 8, 16, 32, 64, 128, 256, 512)) NOT VALID;
