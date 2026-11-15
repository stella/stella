-- requires: 20261115130000_corpus_projection_offline_delivery
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- What a failure of a committed offline revision is charged to, written with
-- its commit (by its record, or by the sweep for a start that expired
-- unrecorded) and read by every prover and by the offline request cap, so the
-- outcome no longer depends on which process decides the revision:
-- `documents` (the usual rules), `killed` (a request of several killed at its
-- deadline: halved, never charged) or `none` (nothing is known about the
-- documents: neither charged nor halved). An ingest revision carries none.
--
-- Only adds: a nullable column with no default (no rewrite) and two checks,
-- NOT VALID, validated by their own online entry. No offline revision was
-- committed before this release, since nothing delivered offline yet, so
-- every row already satisfies both; every write of the previous release
-- passes them too, as it never commits an offline revision.
ALTER TABLE "corpus_index_projection_intents"
  ADD COLUMN "append_fault" text,
  ADD CONSTRAINT "corpus_index_projection_intents_append_fault_values"
    CHECK ("append_fault" IN ('documents','killed','none')) NOT VALID,
  ADD CONSTRAINT "corpus_index_projection_intents_append_fault_shape"
    CHECK (("append_fault" IS NOT NULL) = ("append_delivery" = 'offline_indexer' AND "append_committed_at" IS NOT NULL)) NOT VALID;
