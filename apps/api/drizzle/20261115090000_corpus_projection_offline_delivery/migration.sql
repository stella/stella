-- requires: 20261115080000_corpus_projection_served_copy_guard
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Offline delivery. A started revision records how it travels to the engine:
-- one ingest request (`ingest_api`, what every earlier writer does, so the
-- column default is right for each row an earlier release writes) or a local
-- indexer run over a file (`offline_indexer`), which stores its document count
-- at the start. An offline revision that an exact census, taken once its
-- indexer had certainly ended, found empty becomes `withdrawn`: terminal, with
-- no delete owed.
--
-- Everything here only adds: a column with a constant default (no rewrite),
-- two checks on it, a status, and two allowed transitions. The status checks
-- are replaced by supersets in the statement that drops their predecessors,
-- NOT VALID; the online repair that validates them already validates them
-- again, and the new checks are validated by their own online entry. Every
-- write the previous release makes passes every check and function below
-- exactly as it passed their predecessors.
-- stella-migration-safety: reviewed drop-constraint - The same atomic statement replaces each status check with a superset; every row and every existing writer satisfies it.
ALTER TABLE "corpus_index_projection_intents"
  ADD COLUMN "append_delivery" text DEFAULT 'ingest_api' NOT NULL,
  ADD CONSTRAINT "corpus_index_projection_intents_append_delivery_values"
    CHECK ("append_delivery" IN ('ingest_api','offline_indexer')) NOT VALID,
  ADD CONSTRAINT "corpus_index_projection_intents_append_delivery_shape"
    CHECK ("append_delivery" = 'ingest_api' OR (
      "append_started_at" IS NOT NULL
      AND "expected_document_count" IS NOT NULL
      AND ("append_committed_at" IS NULL OR "append_publish_barrier_at" IS NOT NULL)
    )) NOT VALID,
  DROP CONSTRAINT "corpus_index_projection_intents_status_values",
  ADD CONSTRAINT "corpus_index_projection_intents_status_values"
    CHECK ("status" IN ('reserved','append_started','append_committed','applied','cleanup_pending','cleanup_started','cleanup_committed','cleanup_stalled','settled','cancelled','withdrawn')) NOT VALID,
  DROP CONSTRAINT "corpus_index_projection_intents_status_shape",
  ADD CONSTRAINT "corpus_index_projection_intents_status_shape"
    CHECK (CASE "status"
      WHEN 'reserved' THEN
        "lease_token" IS NOT NULL
        AND "append_started_at" IS NULL
        AND "append_committed_at" IS NULL
        AND "applied_at" IS NULL
        AND "append_publish_barrier_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'append_started' THEN
        "lease_token" IS NOT NULL
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NULL
        AND "applied_at" IS NULL
        AND "append_publish_barrier_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'append_committed' THEN
        ("lease_token" IS NULL) = ("append_publish_barrier_at" IS NOT NULL)
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NOT NULL
        AND "applied_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'applied' THEN
        "lease_token" IS NULL
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NOT NULL
        AND "applied_at" IS NOT NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'cleanup_pending' THEN
        "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'cleanup_started' THEN
        "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NOT NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'cleanup_committed' THEN
        "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NOT NULL
        AND "delete_opstamp" IS NOT NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'cleanup_stalled' THEN
        "lease_token" IS NULL
        AND "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NOT NULL
        AND "delete_opstamp" IS NOT NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'settled' THEN
        "lease_token" IS NULL
        AND "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NOT NULL
        AND "delete_opstamp" IS NOT NULL
        AND "settled_at" IS NOT NULL
        AND "cancelled_at" IS NULL
      WHEN 'cancelled' THEN
        "lease_token" IS NULL
        AND "append_started_at" IS NULL
        AND "append_committed_at" IS NULL
        AND "applied_at" IS NULL
        AND "append_publish_barrier_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NOT NULL
      WHEN 'withdrawn' THEN
        "lease_token" IS NULL
        AND "append_delivery" = 'offline_indexer'
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "expected_document_count" IS NOT NULL
        AND "applied_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      ELSE false
    END) NOT VALID;--> statement-breakpoint

-- Two transitions are added, nothing else changes:
-- `append_committed -> withdrawn` (the status shape admits only an offline
-- revision there) and `withdrawn -> cleanup_pending`, the reopen a census
-- that observes a withdrawn revision's documents takes, as it does for a
-- settled one.
CREATE OR REPLACE FUNCTION "corpus_index_projection_intent_transition_allowed"(
  from_status text,
  to_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE from_status
    WHEN 'reserved' THEN to_status IN ('append_started','cancelled')
    WHEN 'append_started' THEN to_status IN ('append_committed','cleanup_pending')
    WHEN 'append_committed' THEN to_status IN ('applied','cleanup_pending','withdrawn')
    WHEN 'applied' THEN to_status = 'cleanup_pending'
    WHEN 'cleanup_pending' THEN to_status IN ('cleanup_started','applied')
    WHEN 'cleanup_started' THEN to_status IN ('cleanup_pending','cleanup_committed')
    WHEN 'cleanup_committed' THEN to_status IN ('settled','cleanup_pending','cleanup_stalled')
    WHEN 'cleanup_stalled' THEN to_status = 'cleanup_pending'
    WHEN 'settled' THEN to_status = 'cleanup_pending'
    WHEN 'withdrawn' THEN to_status = 'cleanup_pending'
    ELSE false
  END
$$;--> statement-breakpoint

-- The delivery a revision started with is immutable from its start, like the
-- start itself: the barrier and the census rule its row is judged by depend
-- on it. A reservation has no start, so the start may set it.
CREATE OR REPLACE FUNCTION "guard_corpus_index_projection_intent_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_allowed boolean;
BEGIN
  IF (NEW."id", NEW."family", NEW."generation", NEW."entity_id", NEW."epoch", NEW."fingerprint", NEW."index_id", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."family", OLD."generation", OLD."entity_id", OLD."epoch", OLD."fingerprint", OLD."index_id", OLD."created_at") THEN
    RAISE EXCEPTION 'corpus index projection intent identity is immutable';
  END IF;

  IF NEW."cleanup_attempts" < OLD."cleanup_attempts" THEN
    RAISE EXCEPTION 'corpus index projection cleanup attempts cannot decrease';
  END IF;

  IF OLD."append_started_at" IS NOT NULL
     AND NEW."append_started_at" IS DISTINCT FROM OLD."append_started_at" THEN
    RAISE EXCEPTION 'corpus index append start is immutable once recorded';
  END IF;
  IF OLD."append_started_at" IS NOT NULL
     AND NEW."append_delivery" IS DISTINCT FROM OLD."append_delivery" THEN
    RAISE EXCEPTION 'corpus index append delivery is immutable once started';
  END IF;
  IF OLD."append_committed_at" IS NOT NULL
     AND NEW."append_committed_at" IS DISTINCT FROM OLD."append_committed_at" THEN
    RAISE EXCEPTION 'corpus index append commit is immutable once recorded';
  END IF;
  IF OLD."applied_at" IS NOT NULL
     AND NEW."applied_at" IS DISTINCT FROM OLD."applied_at" THEN
    RAISE EXCEPTION 'corpus index apply time is immutable once recorded';
  END IF;
  IF OLD."append_publish_barrier_at" IS NOT NULL
     AND NEW."append_publish_barrier_at" IS DISTINCT FROM OLD."append_publish_barrier_at" THEN
    RAISE EXCEPTION 'corpus index append barrier is immutable once recorded';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    transition_allowed := corpus_index_projection_intent_transition_allowed(
      OLD."status",
      NEW."status"
    );
    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'invalid corpus index projection intent transition: % -> %', OLD."status", NEW."status";
    END IF;
    IF OLD."status" = 'cleanup_pending' AND NEW."status" = 'applied' THEN
      -- A restore is not a new append: the state's desired epoch has moved
      -- past this revision, which is why it was queued. It is admitted only
      -- for a revision no delete can have reached, which the state still
      -- names at its own epoch, and which exactly one desired change
      -- separates from the desired state. A change of the desired value
      -- needs a strictly newer epoch, so an erasure and its undo take two.
      IF NOT (
        OLD."cleanup_attempts" = 0
        AND NEW."cleanup_attempts" = 0
        AND OLD."applied_at" IS NOT NULL
        AND OLD."last_error" IS NULL
      ) THEN
        RAISE EXCEPTION 'only a never-deleted revision can be restored';
      END IF;
      PERFORM 1
      FROM "corpus_index_projection_states" state
      WHERE state."applied_revision" = NEW."id"
        AND state."desired_action" = 'upsert'
        AND state."applied_action" = 'upsert'
        AND state."applied_epoch" = NEW."epoch"
        AND state."desired_epoch" = NEW."epoch" + 1
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'only a revision its unchanged upsert state still names can be restored';
      END IF;
    ELSIF NEW."status" IN ('append_started','append_committed','applied')
    THEN
      PERFORM 1
      FROM "corpus_index_projection_states" state
      WHERE state."family" = NEW."family"
        AND state."generation" = NEW."generation"
        AND state."entity_id" = NEW."entity_id"
        AND state."desired_action" = 'upsert'
        AND state."desired_epoch" = NEW."epoch"
        AND state."desired_fingerprint" = NEW."fingerprint"
        AND state."desired_index_id" = NEW."index_id"
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'stale corpus index projection intent cannot advance';
      END IF;
    END IF;
  END IF;

  IF OLD."status" = 'applied' AND NEW."status" = 'cleanup_pending'
     AND EXISTS (
       SELECT 1 FROM "corpus_index_projection_states" state
       WHERE state."applied_revision" = OLD."id"
         AND state."desired_action" <> 'erase'
         AND state."desired_epoch" <= OLD."epoch"
         AND NOT (
           state."work_status" = 'repair_scheduled'
           AND state."desired_action" = 'upsert'
           AND state."desired_epoch" = OLD."epoch"
           AND state."desired_fingerprint" = OLD."fingerprint"
           AND state."desired_index_id" = OLD."index_id"
         )
     ) THEN
    RAISE EXCEPTION 'current corpus index projection revision requires newer desired state or exact repair before cleanup';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- An erasure applies once every earlier revision is terminal; a withdrawn
-- revision is, since nothing of it reached the index. Nothing else changes.
CREATE OR REPLACE FUNCTION "guard_corpus_index_projection_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_epoch bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."family", NEW."generation", NEW."entity_id", NEW."created_at")
       IS DISTINCT FROM
       (OLD."family", OLD."generation", OLD."entity_id", OLD."created_at") THEN
      RAISE EXCEPTION 'corpus index projection state identity is immutable';
    END IF;
    IF NEW."desired_epoch" < OLD."desired_epoch" THEN
      RAISE EXCEPTION 'corpus index desired epoch cannot decrease';
    END IF;
    IF (NEW."desired_action", NEW."desired_fingerprint", NEW."desired_index_id")
       IS DISTINCT FROM (OLD."desired_action", OLD."desired_fingerprint", OLD."desired_index_id")
       AND NEW."desired_epoch" <= OLD."desired_epoch" THEN
      RAISE EXCEPTION 'changed corpus index desired state requires a newer epoch';
    END IF;
    -- The row runs after the statements that moved its revision, so it sees
    -- the revision's new status: un-naming is admitted only once the copy it
    -- named has left `applied`.
    IF OLD."applied_epoch" IS NOT NULL
       AND (NEW."applied_epoch" IS NULL OR NEW."applied_epoch" < OLD."applied_epoch")
       AND NOT (
         OLD."applied_action" = 'erase'
         AND NEW."applied_action" IS NULL
       )
       AND NOT (
         OLD."applied_action" = 'upsert'
         AND NEW."applied_action" IS NULL
         AND EXISTS (
           SELECT 1
           FROM "corpus_index_projection_intents" named
           WHERE named."id" = OLD."applied_revision"
             AND named."status" <> 'applied'
         )
       ) THEN
      RAISE EXCEPTION 'corpus index applied epoch cannot decrease';
    END IF;
  END IF;

  IF NEW."family" = 'case_law' THEN
    SELECT "projection_epoch" INTO canonical_epoch
    FROM "case_law_decisions"
    WHERE "id" = NEW."entity_id";
  ELSIF NEW."family" = 'legislation' THEN
    SELECT "projection_epoch" INTO canonical_epoch
    FROM "legislation_documents"
    WHERE "id" = NEW."entity_id";
  END IF;
  IF canonical_epoch IS NULL THEN
    IF TG_OP <> 'UPDATE'
       OR OLD."desired_action" IS DISTINCT FROM 'erase'
       OR (NEW."desired_action", NEW."desired_epoch", NEW."desired_fingerprint", NEW."desired_index_id")
          IS DISTINCT FROM
          (OLD."desired_action", OLD."desired_epoch", OLD."desired_fingerprint", OLD."desired_index_id")
    THEN
      RAISE EXCEPTION 'corpus index desired epoch must match the canonical row';
    END IF;
  ELSIF canonical_epoch <> NEW."desired_epoch" THEN
    RAISE EXCEPTION 'corpus index desired epoch must match the canonical row';
  END IF;

  IF NEW."applied_action" = 'upsert' AND NOT EXISTS (
    SELECT 1
    FROM "corpus_index_projection_intents" intent
    WHERE intent."id" = NEW."applied_revision"
      AND intent."family" = NEW."family"
      AND intent."generation" = NEW."generation"
      AND intent."entity_id" = NEW."entity_id"
      AND intent."epoch" = NEW."applied_epoch"
      AND intent."fingerprint" = NEW."applied_fingerprint"
      AND intent."index_id" = NEW."applied_index_id"
      AND intent."status" IN (
        'applied',
        'cleanup_pending',
        'cleanup_started',
        'cleanup_committed',
        'settled'
      )
  ) THEN
    RAISE EXCEPTION 'applied corpus index state requires its exact applied history intent';
  END IF;

  IF NEW."applied_action" = 'erase' AND EXISTS (
    SELECT 1
    FROM "corpus_index_projection_intents" intent
    WHERE intent."family" = NEW."family"
      AND intent."generation" = NEW."generation"
      AND intent."entity_id" = NEW."entity_id"
      AND intent."epoch" <= NEW."applied_epoch"
      AND intent."status" NOT IN ('settled', 'cancelled', 'withdrawn')
  ) THEN
    RAISE EXCEPTION 'erased corpus index state requires every prior revision settled';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Retired history may drop a withdrawn revision like a settled one. Nothing
-- else changes.
CREATE OR REPLACE FUNCTION public."guard_corpus_index_projection_history_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_status text;
  rebuild_fenced boolean;
BEGIN
  SELECT generation."status"
  INTO generation_status
  FROM public."corpus_index_generations" generation
  WHERE generation."family" = OLD."family"
    AND generation."generation" = OLD."generation";

  IF generation_status NOT IN ('retiring', 'retired') THEN
    RAISE EXCEPTION 'corpus index projection history requires a retiring or retired generation';
  END IF;

  IF generation_status = 'retiring' THEN
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_locks held
      WHERE held."locktype" = 'advisory'
        AND held."pid" = pg_catalog.pg_backend_pid()
        AND held."classid" = 1937007986::oid
        AND held."objid" = 1::oid
        AND held."objsubid" = 2
        AND held."mode" = 'ExclusiveLock'
        AND held."granted"
    ) INTO rebuild_fenced;
    IF NOT rebuild_fenced THEN
      RAISE EXCEPTION 'retiring corpus index projection history requires the rebuild fence';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'corpus_index_projection_intents'
     AND (to_jsonb(OLD)->>'status') NOT IN ('settled', 'cancelled', 'withdrawn') THEN
    RAISE EXCEPTION 'nonterminal corpus index projection intent cannot be deleted';
  END IF;

  IF TG_TABLE_NAME = 'corpus_index_projection_states' AND EXISTS (
    SELECT 1
    FROM public."corpus_index_projection_intents" intent
    WHERE intent."family" = OLD."family"
      AND intent."generation" = OLD."generation"
      AND intent."entity_id" = OLD."entity_id"
      AND intent."status" NOT IN ('settled', 'cancelled', 'withdrawn')
  ) THEN
    RAISE EXCEPTION 'projection state with nonterminal intents cannot be deleted';
  END IF;

  RETURN OLD;
END;
$$;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - unchanged body and trusted search_path; a withdrawn revision now counts as terminal history, which the delete guard above admits too
CREATE OR REPLACE FUNCTION public."purge_retired_corpus_index_projection_history"(
  target_family text,
  target_generation text,
  max_entities integer
)
RETURNS TABLE (
  deleted_state_count integer,
  deleted_intent_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  selected_entities uuid[];
  state_count integer;
  intent_count integer;
BEGIN
  IF max_entities IS NULL OR max_entities < 1 OR max_entities > 10000 THEN
    RAISE EXCEPTION 'projection history purge batch must be between 1 and 10000 entities';
  END IF;

  PERFORM 1
  FROM public."corpus_index_generations" generation
  WHERE generation."family" = target_family
    AND generation."generation" = target_generation
    AND generation."status" = 'retired'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'projection history purge requires a retired generation';
  END IF;

  SELECT array_agg(candidate."entity_id")
  INTO selected_entities
  FROM (
    SELECT state."entity_id"
    FROM public."corpus_index_projection_states" state
    WHERE state."family" = target_family
      AND state."generation" = target_generation
      AND NOT EXISTS (
        SELECT 1
        FROM public."corpus_index_projection_intents" intent
        WHERE intent."family" = state."family"
          AND intent."generation" = state."generation"
          AND intent."entity_id" = state."entity_id"
          AND intent."status" NOT IN ('settled', 'cancelled', 'withdrawn')
      )
    ORDER BY state."entity_id"
    LIMIT max_entities
    FOR UPDATE OF state SKIP LOCKED
  ) candidate;

  IF selected_entities IS NULL THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  DELETE FROM public."corpus_index_projection_states" state
  WHERE state."family" = target_family
    AND state."generation" = target_generation
    AND state."entity_id" = ANY(selected_entities);
  GET DIAGNOSTICS state_count = ROW_COUNT;

  DELETE FROM public."corpus_index_projection_intents" intent
  WHERE intent."family" = target_family
    AND intent."generation" = target_generation
    AND intent."entity_id" = ANY(selected_entities);
  GET DIAGNOSTICS intent_count = ROW_COUNT;

  RETURN QUERY SELECT state_count, intent_count;
END;
$$;--> statement-breakpoint

-- The online phase builds corpus_index_projection_intents_withdrawn_census_idx
-- (the absent census's withdrawn half) concurrently and validates the two
-- delivery checks.
