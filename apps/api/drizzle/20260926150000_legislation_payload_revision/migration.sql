-- Track legislation payload revisions and record which works they touch.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "legislation_work_changes" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME "legislation_work_changes_id_seq") NOT NULL,
  "country" varchar(3) NOT NULL,
  "eli" varchar(512) NOT NULL,
  "changed_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "legislation_work_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legislation_work_changes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_work_changes"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
-- With row security forced, the owner is bound by policy too. Owner-context
-- writes to legislation_documents (migrations, operator repairs) still fire the
-- change trigger, so any role may append a change; table privileges decide who
-- can (the owner and stella_ingestion), and nothing but the ingestion policy
-- lets a role read, update or delete a queued change. The owner role is named
-- per deployment, so the policy cannot name it.
-- stella-migration-safety: reviewed permissive-policy - INSERT only; stella
-- holds no privilege on the table and stella_ingestion only INSERT, so the
-- policy admits only the owner and the ingestion role, and reads nothing.
-- Rollback drops the table.
CREATE POLICY "legislation_work_change_append" ON "legislation_work_changes"
  AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "legislation_work_changes" FROM stella;--> statement-breakpoint
-- The change trigger runs as the writer of legislation_documents, so that
-- writer needs INSERT here and nothing more.
GRANT INSERT ON TABLE "legislation_work_changes" TO stella_ingestion;--> statement-breakpoint

-- The only definition of the payload inputs. Every revision advance passes
-- through this function, and the change trigger below keys on the revision,
-- so the two cannot disagree about which columns count.
--
-- `document_ast` is compared only when the statement assigns it: the
-- column-specific trigger calls the 'document_ast' path, and the row trigger
-- never reads the column, so an update that leaves it out never detoasts a
-- whole statute. A column-specific trigger does not see a change another
-- BEFORE trigger makes; no trigger on this table writes `document_ast`.
--
-- Trigger order is name order. The row trigger (`..._payload_revision`) sorts
-- before the AST trigger (`..._payload_revision_ast`), so it checks the
-- client's value before the AST path advances it. Both sort before
-- `legislation_documents_projection_epoch_monotonic`, which reads and writes
-- neither column.
CREATE FUNCTION "advance_legislation_payload_revision"()
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

  IF TG_ARGV[0] = 'document_ast' THEN
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
    OLD."country"
  ) IS DISTINCT FROM (
    NEW."ast_s3_key",
    NEW."content_hash",
    NEW."text_s3_key",
    NEW."source_id",
    NEW."language",
    NEW."eli",
    NEW."version_valid_from",
    NEW."version_valid_to",
    NEW."country"
  ) THEN
    NEW."payload_revision" := OLD."payload_revision" + 1;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Insert a work key for each side of the change: the new key on insert, the
-- old key on delete, both on an update that moves the row to another work.
CREATE FUNCTION "record_legislation_work_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO "legislation_work_changes" ("country", "eli")
    VALUES (OLD."country", OLD."eli");
  END IF;

  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE'
    AND (OLD."country", OLD."eli") IS DISTINCT FROM (NEW."country", NEW."eli")
  ) THEN
    INSERT INTO "legislation_work_changes" ("country", "eli")
    VALUES (NEW."country", NEW."eli");
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- ADD COLUMN and CREATE TRIGGER both need a lock on the hot legislation
-- table. Take the strongest one first with bounded, retried waits; the
-- transaction keeps it through the statements below. The raised lock_timeout
-- is local to each attempt, while statement_timeout bounds the whole sequence.
SET LOCAL statement_timeout = '10min';--> statement-breakpoint
DO $$
DECLARE
  attempts integer := 0;
  holders text;
BEGIN
  LOOP
    attempts := attempts + 1;
    PERFORM set_config(
      'lock_timeout',
      CASE
        WHEN attempts <= 20 THEN '2s'
        WHEN attempts <= 30 THEN '10s'
        ELSE '30s'
      END,
      true
    );
    BEGIN
      LOCK TABLE "legislation_documents" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION
      WHEN lock_not_available THEN
        IF attempts >= 36 THEN
          RAISE;
        END IF;
        IF attempts % 5 = 0 THEN
          SELECT string_agg(
                   format('%s %s %s', activity.pid,
                          coalesce(activity.application_name, '?'),
                          date_trunc('second', now() - activity.xact_start)),
                   '; ')
            INTO holders
            FROM pg_catalog.pg_locks held_lock
            JOIN pg_catalog.pg_stat_activity activity
              ON activity.pid = held_lock.pid
           WHERE held_lock.relation = 'legislation_documents'::regclass
             AND held_lock.granted
             AND activity.pid <> pg_backend_pid();
          RAISE WARNING 'legislation payload revision: attempt % could not lock legislation_documents; holders: %',
            attempts, coalesce(holders, 'none');
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legislation_documents"
  ADD COLUMN "payload_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint

CREATE TRIGGER "legislation_documents_payload_revision"
BEFORE INSERT OR UPDATE ON "legislation_documents"
FOR EACH ROW EXECUTE FUNCTION "advance_legislation_payload_revision"('row');--> statement-breakpoint

CREATE TRIGGER "legislation_documents_payload_revision_ast"
BEFORE UPDATE OF "document_ast" ON "legislation_documents"
FOR EACH ROW
WHEN (OLD."document_ast" IS DISTINCT FROM NEW."document_ast")
EXECUTE FUNCTION "advance_legislation_payload_revision"('document_ast');--> statement-breakpoint

CREATE TRIGGER "legislation_documents_work_change"
AFTER INSERT OR DELETE ON "legislation_documents"
FOR EACH ROW EXECUTE FUNCTION "record_legislation_work_change"();--> statement-breakpoint

CREATE TRIGGER "legislation_documents_work_change_update"
AFTER UPDATE ON "legislation_documents"
FOR EACH ROW
WHEN (OLD."payload_revision" IS DISTINCT FROM NEW."payload_revision")
EXECUTE FUNCTION "record_legislation_work_change"();
