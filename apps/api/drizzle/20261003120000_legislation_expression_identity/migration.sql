SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A stable publisher identity for each stored legislation version, plus the
-- typed fields that say what the version is and whether its window can answer
-- a point-in-time read. Additive only: every existing row reads as an
-- effective consolidation, no writer has to supply the new fields yet, and no
-- constraint here depends on data a writer has not written.
--
-- Everything before the COMMIT below is replayed from the top when a failure
-- after the COMMIT leaves the migration unrecorded, so each statement there
-- survives a second run.

-- A source's namespace is set once and never changed: ids already stored
-- under it carry it as their prefix.
CREATE OR REPLACE FUNCTION "guard_legislation_source_expression_namespace"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD."expression_namespace" IS NOT NULL
     AND NEW."expression_namespace" IS DISTINCT FROM OLD."expression_namespace" THEN
    RAISE EXCEPTION 'legislation source expression namespace is set once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- A publisher expression id is set once, from null, and never changed; it
-- carries its source's namespace as a prefix. A source with no namespace
-- accepts no id, so an id is never stored under a prefix nobody declared.
CREATE OR REPLACE FUNCTION "guard_legislation_publisher_expression_id"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  namespace varchar;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."publisher_expression_id" IS NOT NULL
     AND NEW."publisher_expression_id" IS DISTINCT FROM OLD."publisher_expression_id" THEN
    RAISE EXCEPTION 'legislation publisher expression id is set once'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."publisher_expression_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW."publisher_expression_id" IS NOT DISTINCT FROM OLD."publisher_expression_id"
     AND NEW."source_id" IS NOT DISTINCT FROM OLD."source_id" THEN
    RETURN NEW;
  END IF;

  SELECT "expression_namespace" INTO namespace
    FROM "legislation_sources"
   WHERE "id" = NEW."source_id";

  IF namespace IS NULL THEN
    RAISE EXCEPTION 'legislation source declares no expression namespace'
      USING ERRCODE = 'check_violation';
  END IF;

  IF left(NEW."publisher_expression_id", length(namespace) + 1) <> namespace || ':'
     OR length(NEW."publisher_expression_id") = length(namespace) + 1 THEN
    RAISE EXCEPTION 'legislation publisher expression id does not carry its source namespace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- ADD COLUMN, ADD CONSTRAINT and CREATE TRIGGER all lock the legislation
-- tables, which the corpus writers use without pause. Take both locks first,
-- in writer order, in attempts that each wait at most one second; the
-- transaction keeps them until the COMMIT below. A failed attempt rolls back
-- its subtransaction, which releases any lock it did take, so a documents
-- lock is never held while the sources lock is still being waited for beyond
-- that second. The attempts are bounded, and statement_timeout bounds the
-- whole sequence.
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
DO $$
DECLARE
  attempts integer := 0;
  holders text;
BEGIN
  LOOP
    attempts := attempts + 1;
    PERFORM set_config('lock_timeout', '1s', true);
    BEGIN
      LOCK TABLE "legislation_documents", "legislation_sources"
        IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION
      WHEN lock_not_available THEN
        IF attempts >= 60 THEN
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
           WHERE held_lock.relation IN (
                   'legislation_documents'::regclass,
                   'legislation_sources'::regclass
                 )
             AND held_lock.granted
             AND activity.pid <> pg_backend_pid();
          RAISE WARNING 'legislation expression identity: attempt % could not lock the legislation tables; holders: %',
            attempts, coalesce(holders, 'none');
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legislation_sources"
  ADD COLUMN IF NOT EXISTS "expression_namespace" varchar(32);--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "legislation_sources"
  DROP CONSTRAINT IF EXISTS "legislation_sources_expression_namespace_shape";--> statement-breakpoint
ALTER TABLE "legislation_sources"
  ADD CONSTRAINT "legislation_sources_expression_namespace_shape"
  CHECK ("expression_namespace" IS NULL OR "expression_namespace" ~ '^[a-z][a-z0-9-]{0,31}$')
  NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - Drops only the trigger the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP TRIGGER IF EXISTS "legislation_sources_expression_namespace_guard"
  ON "legislation_sources";--> statement-breakpoint
CREATE TRIGGER "legislation_sources_expression_namespace_guard"
BEFORE UPDATE OF "expression_namespace" ON "legislation_sources"
FOR EACH ROW EXECUTE FUNCTION "guard_legislation_source_expression_namespace"();--> statement-breakpoint

-- Constant defaults, so no row is rewritten.
ALTER TABLE "legislation_documents"
  ADD COLUMN IF NOT EXISTS "publisher_expression_id" varchar(1024);--> statement-breakpoint
ALTER TABLE "legislation_documents"
  ADD COLUMN IF NOT EXISTS "expression_kind" varchar(16) DEFAULT 'consolidation' NOT NULL;--> statement-breakpoint
ALTER TABLE "legislation_documents"
  ADD COLUMN IF NOT EXISTS "window_disposition" varchar(16) DEFAULT 'effective' NOT NULL;--> statement-breakpoint
ALTER TABLE "legislation_documents"
  ADD COLUMN IF NOT EXISTS "window_disposition_basis" varchar(32);--> statement-breakpoint

-- NOT VALID here, VALIDATE after the transaction splits. A validating CHECK
-- scans every row while holding ACCESS EXCLUSIVE; NOT VALID records the
-- constraint, which then applies to every later INSERT and UPDATE. Each is
-- dropped first so the file is re-runnable after a failed VALIDATE.
-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "legislation_documents"
  DROP CONSTRAINT IF EXISTS "legislation_documents_expression_kind_values";--> statement-breakpoint
ALTER TABLE "legislation_documents"
  ADD CONSTRAINT "legislation_documents_expression_kind_values"
  CHECK ("expression_kind" IN ('consolidation','promulgated','unversioned'))
  NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "legislation_documents"
  DROP CONSTRAINT IF EXISTS "legislation_documents_window_disposition_values";--> statement-breakpoint
ALTER TABLE "legislation_documents"
  ADD CONSTRAINT "legislation_documents_window_disposition_values"
  CHECK ("window_disposition" IN ('effective','never-in-force','invalid-window','withdrawn'))
  NOT VALID;--> statement-breakpoint

-- An effective row carries no basis: its window is the publisher's, never
-- inferred. Every other disposition names its basis. The IS NOT NULL is not
-- redundant: a CHECK passes on NULL, and `NULL IN (...)` is NULL.
-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "legislation_documents"
  DROP CONSTRAINT IF EXISTS "legislation_documents_window_disposition_basis_pairing";--> statement-breakpoint
ALTER TABLE "legislation_documents"
  ADD CONSTRAINT "legislation_documents_window_disposition_basis_pairing"
  CHECK (
    (window_disposition = 'effective' AND window_disposition_basis IS NULL)
    OR (window_disposition = 'never-in-force' AND (window_disposition_basis IS NOT NULL AND window_disposition_basis IN ('publisher-flag','replaced-same-day')))
    OR (window_disposition = 'invalid-window' AND (window_disposition_basis IS NOT NULL AND window_disposition_basis IN ('zero-length-window','reversed','missing-start')))
    OR (window_disposition = 'withdrawn' AND (window_disposition_basis IS NOT NULL AND window_disposition_basis IN ('publisher-unlisted','listed-not-stored','deferred-promulgated')))
  )
  NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - Drops only the trigger the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP TRIGGER IF EXISTS "legislation_documents_expression_id_guard"
  ON "legislation_documents";--> statement-breakpoint
CREATE TRIGGER "legislation_documents_expression_id_guard"
BEFORE INSERT OR UPDATE OF "publisher_expression_id", "source_id"
ON "legislation_documents"
FOR EACH ROW EXECUTE FUNCTION "guard_legislation_publisher_expression_id"();--> statement-breakpoint

GRANT SELECT (expression_kind, window_disposition, window_disposition_basis)
  ON TABLE "legislation_documents"
  TO stella_public_law_reader;--> statement-breakpoint
GRANT SELECT (expression_kind, window_disposition, window_disposition_basis)
  ON TABLE "legislation_documents"
  TO stella_corpus_sample_reader;--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, and validating a
-- constraint inside it would hold every lock taken above while the scan runs.
-- Split the migrator transaction, bound the scans, then restore and reopen a
-- transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts -- Validates the NOT VALID constraint added above, outside the additive DDL transaction so its scan does not retain earlier locks.
ALTER TABLE "legislation_sources"
  VALIDATE CONSTRAINT "legislation_sources_expression_namespace_shape";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validates the NOT VALID constraint added above, outside the additive DDL transaction so its scan does not retain earlier locks.
ALTER TABLE "legislation_documents"
  VALIDATE CONSTRAINT "legislation_documents_expression_kind_values";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validates the NOT VALID constraint added above, outside the additive DDL transaction so its scan does not retain earlier locks.
ALTER TABLE "legislation_documents"
  VALIDATE CONSTRAINT "legislation_documents_window_disposition_values";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validates the NOT VALID constraint added above, outside the additive DDL transaction so its scan does not retain earlier locks.
ALTER TABLE "legislation_documents"
  VALIDATE CONSTRAINT "legislation_documents_window_disposition_basis_pairing";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
