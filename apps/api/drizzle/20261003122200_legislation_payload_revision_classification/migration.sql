SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A version's classification (its kind, and whether its window can apply and
-- why not) decides what the corpus says about its Work, so a change to it is a
-- payload change: it advances the revision and queues the Work like a changed
-- window does.
--
-- The publisher's expression id stays out. Attaching it is an identity
-- claim, not an edit, and the backfill claims every stored version once; a
-- claim that advanced the revision would queue each of their Works for
-- nothing.
--
-- Replaces the function body only. The row trigger names no columns, so no
-- trigger is re-created and the hot table takes no lock; the next statement
-- in any session reads the new body.
CREATE OR REPLACE FUNCTION "advance_legislation_payload_revision"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."payload_revision" IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'legislation payload revision is maintained by the database'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_ARGV[0] = 'column' THEN
    NEW."payload_revision" := OLD."payload_revision" + 1;
    RETURN NEW;
  END IF;

  IF NEW."payload_revision" IS DISTINCT FROM OLD."payload_revision" THEN
    RAISE EXCEPTION 'legislation payload revision is maintained by the database'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (
    OLD."ast_s3_key",
    OLD."content_hash",
    OLD."text_s3_key",
    OLD."source_id",
    OLD."language",
    OLD."eli",
    OLD."version_valid_from",
    OLD."version_valid_to",
    OLD."country",
    OLD."expression_kind",
    OLD."window_disposition",
    OLD."window_disposition_basis"
  ) IS DISTINCT FROM (
    NEW."ast_s3_key",
    NEW."content_hash",
    NEW."text_s3_key",
    NEW."source_id",
    NEW."language",
    NEW."eli",
    NEW."version_valid_from",
    NEW."version_valid_to",
    NEW."country",
    NEW."expression_kind",
    NEW."window_disposition",
    NEW."window_disposition_basis"
  ) THEN
    NEW."payload_revision" := OLD."payload_revision" + 1;
  END IF;
  RETURN NEW;
END;
$$;
