SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Settlement proves a delete against the splits that could hold the revisions
-- it targeted, which is decided by the metastore's own creation instant for
-- the delete task. The opstamp alone is no longer a complete receipt.
ALTER TABLE "corpus_index_projection_intents"
  ADD COLUMN "delete_task_created_at" timestamptz;--> statement-breakpoint

-- The status shape already decides per status whether a delete receipt is on
-- the row; pairing the two receipt columns keeps that one decision total.
-- NOT VALID because receipts recorded before this column existed carry an
-- opstamp and no instant: the online repair
-- `corpus-projection-delete-receipt` fills those in and validates this
-- constraint when none is left.
ALTER TABLE "corpus_index_projection_intents"
  ADD CONSTRAINT "corpus_index_projection_intents_delete_receipt_paired"
    CHECK (("delete_opstamp" IS NULL) = ("delete_task_created_at" IS NULL))
    NOT VALID;--> statement-breakpoint
