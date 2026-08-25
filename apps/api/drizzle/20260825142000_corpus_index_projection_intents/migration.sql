SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD COLUMN "projection_epoch" bigint DEFAULT 0 NOT NULL,
  ADD CONSTRAINT "case_law_decisions_projection_epoch_nonnegative"
    CHECK ("projection_epoch" >= 0) NOT VALID;--> statement-breakpoint

ALTER TABLE "legislation_documents"
  ADD COLUMN "projection_epoch" bigint DEFAULT 0 NOT NULL,
  ADD CONSTRAINT "legislation_documents_projection_epoch_nonnegative"
    CHECK ("projection_epoch" >= 0) NOT VALID;--> statement-breakpoint

CREATE TABLE "corpus_index_projection_intents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "entity_id" uuid NOT NULL,
  "epoch" bigint NOT NULL,
  "fingerprint" varchar(64) NOT NULL,
  "index_id" varchar(64) NOT NULL,
  "status" text NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "append_started_at" timestamptz,
  "append_committed_at" timestamptz,
  "applied_at" timestamptz,
  "append_publish_barrier_at" timestamptz,
  "cleanup_not_before" timestamptz,
  "cleanup_started_at" timestamptz,
  "delete_opstamp" bigint,
  "settled_at" timestamptz,
  "cancelled_at" timestamptz,
  "cleanup_attempts" integer DEFAULT 0 NOT NULL,
  "last_error" varchar(2048),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_projection_intents_generation_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "corpus_index_generations" ("family", "generation")
    ON DELETE RESTRICT,
  CONSTRAINT "corpus_index_projection_intents_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_projection_intents_status_values"
    CHECK ("status" IN (
      'reserved','append_started','append_committed','applied',
      'cleanup_pending','cleanup_started','cleanup_committed','settled','cancelled'
    )),
  CONSTRAINT "corpus_index_projection_intents_epoch_positive"
    CHECK ("epoch" > 0),
  CONSTRAINT "corpus_index_projection_intents_fingerprint_shape"
    CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "corpus_index_projection_intents_index_id_shape"
    CHECK ("index_id" ~ '^[a-z0-9_]+$'),
  CONSTRAINT "corpus_index_projection_intents_lease_shape"
    CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "corpus_index_projection_intents_cleanup_attempts_nonnegative"
    CHECK ("cleanup_attempts" >= 0),
  CONSTRAINT "corpus_index_projection_intents_delete_opstamp_nonnegative"
    CHECK ("delete_opstamp" IS NULL OR "delete_opstamp" >= 0),
  CONSTRAINT "corpus_index_projection_intents_status_shape"
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
        "lease_token" IS NOT NULL
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NOT NULL
        AND "applied_at" IS NULL
        AND "append_publish_barrier_at" IS NULL
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
        AND "append_publish_barrier_at" IS NULL
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
      ELSE false
    END),
  CONSTRAINT "corpus_index_projection_intents_cleanup_order"
    CHECK ("cleanup_not_before" IS NULL OR (
      "cleanup_not_before" >= "append_publish_barrier_at"
      AND ("cleanup_started_at" IS NULL OR "cleanup_started_at" >= "cleanup_not_before")
      AND ("settled_at" IS NULL OR "settled_at" >= "cleanup_started_at")
    )),
  CONSTRAINT "corpus_index_projection_intents_append_order"
    CHECK (("append_committed_at" IS NULL OR "append_committed_at" >= "append_started_at")
      AND ("applied_at" IS NULL OR "applied_at" >= "append_committed_at")
      AND ("append_publish_barrier_at" IS NULL OR "append_publish_barrier_at" >= "append_started_at"))
);--> statement-breakpoint

CREATE UNIQUE INDEX "corpus_index_projection_intents_live_epoch_uidx"
  ON "corpus_index_projection_intents" ("family", "generation", "entity_id", "epoch")
  WHERE "status" NOT IN ('settled', 'cancelled');--> statement-breakpoint

CREATE UNIQUE INDEX "corpus_index_projection_intents_identity_uidx"
  ON "corpus_index_projection_intents"
  ("id", "family", "generation", "entity_id", "epoch", "fingerprint", "index_id");--> statement-breakpoint

CREATE INDEX "corpus_index_projection_intents_work_idx"
  ON "corpus_index_projection_intents"
  ("family", "generation", "status", "cleanup_not_before", "lease_expires_at", "created_at");--> statement-breakpoint

CREATE INDEX "corpus_index_projection_intents_entity_idx"
  ON "corpus_index_projection_intents"
  ("family", "generation", "entity_id", "created_at");--> statement-breakpoint

CREATE TABLE "corpus_index_projection_states" (
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "entity_id" uuid NOT NULL,
  "desired_action" text NOT NULL,
  "desired_epoch" bigint NOT NULL,
  "desired_fingerprint" varchar(64),
  "desired_index_id" varchar(64),
  "applied_action" text,
  "applied_epoch" bigint,
  "applied_revision" uuid,
  "applied_fingerprint" varchar(64),
  "applied_index_id" varchar(64),
  "applied_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_projection_states_pkey"
    PRIMARY KEY ("family", "generation", "entity_id"),
  CONSTRAINT "corpus_index_projection_states_generation_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "corpus_index_generations" ("family", "generation")
    ON DELETE RESTRICT,
  CONSTRAINT "corpus_index_projection_states_applied_revision_fk"
    FOREIGN KEY (
      "applied_revision", "family", "generation", "entity_id",
      "applied_epoch", "applied_fingerprint", "applied_index_id"
    ) REFERENCES "corpus_index_projection_intents" (
      "id", "family", "generation", "entity_id", "epoch", "fingerprint",
      "index_id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "corpus_index_projection_states_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_projection_states_desired_action_values"
    CHECK ("desired_action" IN ('upsert','erase')),
  CONSTRAINT "corpus_index_projection_states_applied_action_values"
    CHECK ("applied_action" IS NULL OR "applied_action" IN ('upsert','erase')),
  CONSTRAINT "corpus_index_projection_states_epoch_order"
    CHECK ("desired_epoch" > 0 AND (
      "applied_epoch" IS NULL
      OR ("applied_epoch" > 0 AND "applied_epoch" <= "desired_epoch")
    )),
  CONSTRAINT "corpus_index_projection_states_desired_shape"
    CHECK (CASE "desired_action"
      WHEN 'upsert' THEN
        "desired_fingerprint" IS NOT NULL
        AND "desired_fingerprint" ~ '^[0-9a-f]{64}$'
        AND "desired_index_id" IS NOT NULL
        AND "desired_index_id" ~ '^[a-z0-9_]+$'
      WHEN 'erase' THEN
        "desired_fingerprint" IS NULL
        AND "desired_index_id" IS NULL
      ELSE false
    END),
  CONSTRAINT "corpus_index_projection_states_applied_shape"
    CHECK (CASE
      WHEN "applied_action" IS NULL THEN
        "applied_epoch" IS NULL
        AND "applied_revision" IS NULL
        AND "applied_fingerprint" IS NULL
        AND "applied_index_id" IS NULL
        AND "applied_at" IS NULL
      WHEN "applied_action" = 'upsert' THEN
        "applied_epoch" IS NOT NULL
        AND "applied_revision" IS NOT NULL
        AND "applied_fingerprint" IS NOT NULL
        AND "applied_fingerprint" ~ '^[0-9a-f]{64}$'
        AND "applied_index_id" IS NOT NULL
        AND "applied_index_id" ~ '^[a-z0-9_]+$'
        AND "applied_at" IS NOT NULL
      WHEN "applied_action" = 'erase' THEN
        "applied_epoch" IS NOT NULL
        AND "applied_revision" IS NULL
        AND "applied_fingerprint" IS NULL
        AND "applied_index_id" IS NULL
        AND "applied_at" IS NOT NULL
      ELSE false
    END)
);--> statement-breakpoint

CREATE UNIQUE INDEX "corpus_index_projection_states_applied_revision_uidx"
  ON "corpus_index_projection_states" ("applied_revision")
  WHERE "applied_revision" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "corpus_index_projection_states_pending_idx"
  ON "corpus_index_projection_states" ("family", "generation", "updated_at", "entity_id")
  WHERE "applied_action" IS NULL
    OR "applied_action" IS DISTINCT FROM "desired_action"
    OR "applied_epoch" IS DISTINCT FROM "desired_epoch"
    OR "applied_fingerprint" IS DISTINCT FROM "desired_fingerprint"
    OR "applied_index_id" IS DISTINCT FROM "desired_index_id";--> statement-breakpoint

CREATE FUNCTION "guard_corpus_projection_epoch"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."projection_epoch" < OLD."projection_epoch" THEN
    RAISE EXCEPTION 'corpus projection epoch cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "case_law_decisions_projection_epoch_monotonic"
  BEFORE UPDATE ON "case_law_decisions"
  FOR EACH ROW EXECUTE FUNCTION "guard_corpus_projection_epoch"();--> statement-breakpoint

CREATE TRIGGER "legislation_documents_projection_epoch_monotonic"
  BEFORE UPDATE ON "legislation_documents"
  FOR EACH ROW EXECUTE FUNCTION "guard_corpus_projection_epoch"();--> statement-breakpoint

-- Retired is the irreversible boundary after which projection history may be
-- deleted. Rollback remains possible while a generation is merely retiring.
CREATE FUNCTION "guard_retired_corpus_index_generation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'retired' AND NEW."status" <> 'retired' THEN
    RAISE EXCEPTION 'retired corpus index generation is terminal';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "corpus_index_generations_retired_terminal"
  BEFORE UPDATE ON "corpus_index_generations"
  FOR EACH ROW EXECUTE FUNCTION "guard_retired_corpus_index_generation"();--> statement-breakpoint

CREATE FUNCTION "guard_corpus_index_projection_intent_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'reserved' THEN
    RAISE EXCEPTION 'corpus index projection intent must start reserved';
  END IF;

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
    RAISE EXCEPTION 'corpus index projection intent does not match desired state';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "corpus_index_projection_intents_insert_guard"
  BEFORE INSERT ON "corpus_index_projection_intents"
  FOR EACH ROW EXECUTE FUNCTION "guard_corpus_index_projection_intent_insert"();--> statement-breakpoint

CREATE FUNCTION "corpus_index_projection_intent_transition_allowed"(
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
    WHEN 'append_committed' THEN to_status IN ('applied','cleanup_pending')
    WHEN 'applied' THEN to_status = 'cleanup_pending'
    WHEN 'cleanup_pending' THEN to_status = 'cleanup_started'
    WHEN 'cleanup_started' THEN to_status IN ('cleanup_pending','cleanup_committed')
    WHEN 'cleanup_committed' THEN to_status = 'settled'
    WHEN 'settled' THEN to_status = 'cleanup_pending'
    ELSE false
  END
$$;--> statement-breakpoint

CREATE FUNCTION "guard_corpus_index_projection_intent_update"()
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
    IF NEW."status" IN ('append_started','append_committed','applied')
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
     ) THEN
    RAISE EXCEPTION 'current corpus index projection revision requires a replacement before cleanup';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "corpus_index_projection_intents_update_guard"
  BEFORE UPDATE ON "corpus_index_projection_intents"
  FOR EACH ROW EXECUTE FUNCTION "guard_corpus_index_projection_intent_update"();--> statement-breakpoint

CREATE FUNCTION "guard_corpus_index_projection_state"()
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
    IF OLD."applied_epoch" IS NOT NULL
       AND (NEW."applied_epoch" IS NULL OR NEW."applied_epoch" < OLD."applied_epoch") THEN
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
  IF canonical_epoch IS NULL OR canonical_epoch <> NEW."desired_epoch" THEN
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
      AND intent."status" = 'applied'
  ) THEN
    RAISE EXCEPTION 'applied corpus index state requires its exact applied intent';
  END IF;

  IF NEW."applied_action" = 'erase' AND EXISTS (
    SELECT 1
    FROM "corpus_index_projection_intents" intent
    WHERE intent."family" = NEW."family"
      AND intent."generation" = NEW."generation"
      AND intent."entity_id" = NEW."entity_id"
      AND intent."epoch" <= NEW."applied_epoch"
      AND intent."status" NOT IN ('settled', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'erased corpus index state requires every prior revision settled';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "corpus_index_projection_states_guard"
  BEFORE INSERT OR UPDATE ON "corpus_index_projection_states"
  FOR EACH ROW EXECUTE FUNCTION "guard_corpus_index_projection_state"();--> statement-breakpoint

CREATE FUNCTION "guard_corpus_index_projection_history_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "corpus_index_generations" generation
    WHERE generation."family" = OLD."family"
      AND generation."generation" = OLD."generation"
      AND generation."status" = 'retired'
  ) THEN
    RAISE EXCEPTION 'corpus index projection history requires a retired generation';
  END IF;

  IF TG_TABLE_NAME = 'corpus_index_projection_intents'
     AND OLD."status" NOT IN ('settled', 'cancelled') THEN
    RAISE EXCEPTION 'nonterminal corpus index projection intent cannot be deleted';
  END IF;

  IF TG_TABLE_NAME = 'corpus_index_projection_states' AND EXISTS (
    SELECT 1
    FROM "corpus_index_projection_intents" intent
    WHERE intent."family" = OLD."family"
      AND intent."generation" = OLD."generation"
      AND intent."entity_id" = OLD."entity_id"
      AND intent."status" NOT IN ('settled', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'projection state with nonterminal intents cannot be deleted';
  END IF;

  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "corpus_index_projection_intents_delete_guard"
  BEFORE DELETE ON "corpus_index_projection_intents"
  FOR EACH ROW EXECUTE FUNCTION "guard_corpus_index_projection_history_delete"();--> statement-breakpoint

CREATE TRIGGER "corpus_index_projection_states_delete_guard"
  BEFORE DELETE ON "corpus_index_projection_states"
  FOR EACH ROW EXECUTE FUNCTION "guard_corpus_index_projection_history_delete"();--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - fixed search_path, retired-generation and terminal-intent checks, plus a 10000-entity ceiling preserve least privilege; rollback drops this function without restoring table DELETE
CREATE FUNCTION "purge_retired_corpus_index_projection_history"(
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
SET search_path = pg_catalog, public
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
          AND intent."status" NOT IN ('settled', 'cancelled')
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

REVOKE ALL ON FUNCTION "purge_retired_corpus_index_projection_history"(text, text, integer)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "purge_retired_corpus_index_projection_history"(text, text, integer)
  TO stella_ingestion;--> statement-breakpoint

ALTER TABLE "corpus_index_projection_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_projection_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_global_access"
  ON "corpus_index_projection_intents"
  AS PERMISSIVE FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_projection_intents"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_projection_states"
  AS PERMISSIVE FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_projection_states"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON TABLE
  "corpus_index_projection_intents",
  "corpus_index_projection_states"
TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  "corpus_index_projection_intents",
  "corpus_index_projection_states"
TO stella_ingestion;
