-- Per-decision provision-citation state: exact spans on the provision rows,
-- the state that records which decision input the rows were produced from,
-- the scopes and extraction revisions that admit work, and the trigger that
-- enqueues a decision whenever one of its extraction inputs changes.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The migrate entrypoint's corpus lane drains application writers before
-- this migration starts, but maintenance can still hold either hot table
-- briefly. Take both locks in corpus-writer order with bounded retries: the
-- provision rows ACCESS EXCLUSIVE for the column and constraint additions,
-- the decisions SHARE ROW EXCLUSIVE for the foreign key and the enqueue
-- trigger. Both are held to commit, and everything after them is catalog
-- work on metadata or on new, empty tables.
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
      LOCK TABLE "case_law_decisions" IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE "case_law_provision_citations" IN ACCESS EXCLUSIVE MODE;
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
           WHERE held_lock.relation IN (
                   'case_law_decisions'::regclass,
                   'case_law_provision_citations'::regclass
                 )
             AND held_lock.granted
             AND activity.pid <> pg_backend_pid();
          RAISE WARNING 'provision extraction state: attempt % could not lock corpus tables; holders: %',
            attempts, coalesce(holders, 'none');
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Nullable, no default: metadata only on the large table.
ALTER TABLE "case_law_provision_citations"
  ADD COLUMN "span_role" text,
  ADD COLUMN "print_piece_id" varchar(64),
  ADD COLUMN "print_start" integer,
  ADD COLUMN "print_end" integer,
  ADD COLUMN "print_text" varchar(128),
  ADD COLUMN "name_piece_id" varchar(64),
  ADD COLUMN "name_start" integer,
  ADD COLUMN "name_end" integer,
  ADD COLUMN "name_text" varchar(256),
  ADD COLUMN "selection" text,
  ADD COLUMN "target_document_id" uuid,
  ADD COLUMN "target_status" text;--> statement-breakpoint

-- NOT VALID skips the scan; every existing row satisfies these CHECKs
-- because the columns they read were just added NULL. Validation is a
-- registered online repair.
ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "provision_citations_span_role_values"
  CHECK ("span_role" IS NULL OR "span_role" IN ('printed','range-interior')) NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "provision_citations_selection_values"
  CHECK ("selection" IS NULL OR "selection" IN ('text','date-window')) NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "provision_citations_target_status_values"
  CHECK ("target_status" IS NULL OR "target_status" IN ('available','anchor_missing','no_version_for_date','work_not_held','unverified_target','incomplete_versions')) NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "provision_citations_print_segment_shape"
  CHECK (
    CASE
      WHEN "span_role" = 'printed' THEN
        num_nulls("print_piece_id", "print_start", "print_end", "print_text") = 0
        AND "print_start" >= 0 AND "print_end" > "print_start"
      ELSE num_nonnulls("print_piece_id", "print_start", "print_end", "print_text") = 0
    END
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "provision_citations_name_segment_shape"
  CHECK (
    num_nonnulls("name_piece_id", "name_start", "name_end", "name_text") = 0
    OR (
      num_nulls("name_piece_id", "name_start", "name_end", "name_text") = 0
      AND "name_start" >= 0 AND "name_end" > "name_start"
    )
  ) NOT VALID;--> statement-breakpoint

CREATE TABLE "case_law_provision_extraction_scopes" (
  "country" varchar(3) NOT NULL,
  "language" varchar(8) NOT NULL,
  "status" text NOT NULL,
  "generation" bigint NOT NULL,
  CONSTRAINT "case_law_provision_extraction_scopes_pkey" PRIMARY KEY ("country", "language"),
  CONSTRAINT "case_law_provision_extraction_scopes_status_values"
    CHECK ("status" IN ('active','retired')),
  CONSTRAINT "case_law_provision_extraction_scopes_generation_positive"
    CHECK ("generation" > 0)
);--> statement-breakpoint

CREATE TABLE "case_law_provision_scope_transitions" (
  "country" varchar(3) NOT NULL,
  "language" varchar(8) NOT NULL,
  "generation" bigint NOT NULL,
  "action" text NOT NULL,
  "cursor_decision_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "case_law_provision_scope_transitions_pkey"
    PRIMARY KEY ("country", "language", "generation"),
  CONSTRAINT "case_law_provision_scope_transitions_scope_fk"
    FOREIGN KEY ("country", "language")
    REFERENCES "case_law_provision_extraction_scopes"("country", "language")
    ON DELETE restrict,
  CONSTRAINT "case_law_provision_scope_transitions_action_values"
    CHECK ("action" IN ('activate','retire'))
);--> statement-breakpoint

CREATE TABLE "case_law_provision_extraction_revisions_registry" (
  "revision" integer NOT NULL,
  "jurisdiction" varchar(3) NOT NULL,
  "engine_input_digest" varchar(64) NOT NULL,
  "profile_digest" varchar(64) NOT NULL,
  "projection_revision" smallint NOT NULL,
  "registered_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_provision_extraction_revisions_registry_pkey"
    PRIMARY KEY ("revision", "jurisdiction"),
  CONSTRAINT "case_law_provision_extraction_registry_positive"
    CHECK ("revision" > 0 AND "projection_revision" > 0),
  CONSTRAINT "case_law_provision_extraction_revisions_registry_digest_shape"
    CHECK ("engine_input_digest" ~ '^[0-9a-f]{64}$' AND "profile_digest" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint

CREATE TABLE "case_law_provision_extraction_revisions" (
  "jurisdiction" varchar(3) PRIMARY KEY,
  "desired_revision" integer NOT NULL,
  "min_current_revision" integer NOT NULL,
  "changed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_provision_extraction_revisions_registry_fk"
    FOREIGN KEY ("desired_revision", "jurisdiction")
    REFERENCES "case_law_provision_extraction_revisions_registry"("revision", "jurisdiction")
    ON DELETE restrict,
  CONSTRAINT "case_law_provision_extraction_revisions_floor"
    CHECK ("min_current_revision" > 0 AND "min_current_revision" <= "desired_revision")
);--> statement-breakpoint

CREATE TABLE "case_law_provision_extractions" (
  "decision_id" uuid PRIMARY KEY,
  "jurisdiction" varchar(3) NOT NULL,
  "desired_input_digest" bytea NOT NULL,
  "lane" text NOT NULL,
  "due_at" timestamptz,
  "enqueue_reason" text,
  "work_status" text DEFAULT 'eligible' NOT NULL,
  "retry_not_before" timestamptz,
  "failure_attempts" integer DEFAULT 0 NOT NULL,
  "transient_attempts" integer DEFAULT 0 NOT NULL,
  "last_failure_kind" varchar(64),
  "last_failure_message" varchar(2048),
  "blocked_input_digest" bytea,
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "generation" bigint DEFAULT 0 NOT NULL,
  "outcome" text,
  "terminal_reason" text,
  "published_input_digest" bytea,
  "published_jurisdiction" varchar(3),
  "published_revision" integer,
  "published_projection_digest" bytea,
  "payload_class" text,
  "payload_class_input_digest" bytea,
  "row_count" integer,
  "rows_digest" varchar(64),
  "unresolved_counts" jsonb,
  "published_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_provision_extractions_decision_fk"
    FOREIGN KEY ("decision_id") REFERENCES "case_law_decisions"("id") ON DELETE cascade,
  CONSTRAINT "case_law_provision_extractions_revision_fk"
    FOREIGN KEY ("published_revision", "published_jurisdiction")
    REFERENCES "case_law_provision_extraction_revisions_registry"("revision", "jurisdiction")
    ON DELETE restrict,
  CONSTRAINT "case_law_provision_extractions_lane_values"
    CHECK ("lane" IN ('fresh','repair','backfill')),
  CONSTRAINT "case_law_provision_extractions_enqueue_reason_values"
    CHECK ("enqueue_reason" IS NULL OR "enqueue_reason" IN ('input','seed','reconcile','scope_activated','scope_retired','revision_sweep')),
  CONSTRAINT "case_law_provision_extractions_work_status_values"
    CHECK ("work_status" IN ('eligible','retry_scheduled','blocked')),
  CONSTRAINT "case_law_provision_extractions_outcome_values"
    CHECK ("outcome" IS NULL OR "outcome" IN ('extracted_with_rows','extracted_zero','terminal')),
  CONSTRAINT "case_law_provision_extractions_terminal_reason_values"
    CHECK ("terminal_reason" IS NULL OR "terminal_reason" IN ('empty_document','withheld','unplaceable','out_of_scope')),
  CONSTRAINT "case_law_provision_extractions_payload_class_values"
    CHECK ("payload_class" IS NULL OR "payload_class" IN ('usable','empty_envelope','unusable')),
  CONSTRAINT "case_law_provision_extractions_digest_lengths"
    CHECK (
      octet_length("desired_input_digest") = 32
      AND coalesce(octet_length("blocked_input_digest"), 32) = 32
      AND coalesce(octet_length("published_input_digest"), 32) = 32
      AND coalesce(octet_length("published_projection_digest"), 32) = 32
      AND coalesce(octet_length("payload_class_input_digest"), 32) = 32
    ),
  CONSTRAINT "case_law_provision_extractions_counters"
    CHECK (
      "generation" >= 0 AND "failure_attempts" >= 0 AND "transient_attempts" >= 0
      AND coalesce("row_count", 0) >= 0
    ),
  CONSTRAINT "case_law_provision_extractions_published_shape"
    CHECK (
      ("generation" = 0) = ("outcome" IS NULL)
      AND ("outcome" IS NULL) = ("published_at" IS NULL)
      AND ("outcome" IS NULL) = ("published_input_digest" IS NULL)
    ),
  CONSTRAINT "case_law_provision_extractions_lease_shape"
    CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "case_law_provision_extractions_retry_shape"
    CHECK ("work_status" <> 'retry_scheduled' OR "retry_not_before" IS NOT NULL),
  CONSTRAINT "case_law_provision_extractions_blocked_shape"
    CHECK ("work_status" <> 'blocked' OR "blocked_input_digest" IS NOT NULL),
  CONSTRAINT "case_law_provision_extractions_terminal_shape"
    CHECK (("terminal_reason" IS NOT NULL) = coalesce("outcome" = 'terminal', false)),
  CONSTRAINT "case_law_provision_extractions_extracted_shape"
    CHECK (
      coalesce("outcome" NOT IN ('extracted_with_rows','extracted_zero'), true)
      OR (
        "row_count" IS NOT NULL AND "rows_digest" IS NOT NULL
        AND "published_projection_digest" IS NOT NULL
        AND ("row_count" = 0) = ("outcome" = 'extracted_zero')
      )
    ),
  CONSTRAINT "case_law_provision_extractions_binding_shape"
    CHECK (
      ("published_revision" IS NULL) = ("published_jurisdiction" IS NULL)
      AND ("published_revision" IS NOT NULL)
        = coalesce("outcome" IN ('extracted_with_rows','extracted_zero'), false)
    ),
  CONSTRAINT "case_law_provision_extractions_payload_class_shape"
    CHECK (("payload_class" IS NULL) = ("payload_class_input_digest" IS NULL)),
  CONSTRAINT "case_law_provision_extractions_rows_digest_shape"
    CHECK ("rows_digest" IS NULL OR "rows_digest" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint

CREATE INDEX "case_law_provision_extractions_due_idx"
  ON "case_law_provision_extractions" ("lane", "due_at", "decision_id")
  WHERE "due_at" IS NOT NULL AND "work_status" <> 'blocked';--> statement-breakpoint
CREATE INDEX "case_law_provision_extractions_retry_idx"
  ON "case_law_provision_extractions" ("retry_not_before", "decision_id")
  WHERE "work_status" = 'retry_scheduled';--> statement-breakpoint
CREATE INDEX "case_law_provision_extractions_blocked_idx"
  ON "case_law_provision_extractions" ("decision_id")
  WHERE "work_status" = 'blocked';--> statement-breakpoint
CREATE INDEX "case_law_provision_extractions_lease_idx"
  ON "case_law_provision_extractions" ("lease_expires_at")
  WHERE "lease_token" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "case_law_provision_extraction_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_scope_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_extraction_revisions_registry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_extraction_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_extractions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_extraction_scopes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_scope_transitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_extraction_revisions_registry" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_extraction_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_extractions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Row security is forced, so the owner is bound by policy too, and the
-- owner-run functions (the enqueue trigger, ensure_…_state, the in-scope
-- predicate, the revision setter) write and read these tables as the owner.
-- The owner role is named per deployment, so the policy cannot name it; table
-- privileges decide who reaches the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all, stella and stella_ingestion only the grants below, and no other role any
CREATE POLICY "case_law_provision_extraction_owner_access" ON "case_law_provision_extraction_scopes"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all, stella and stella_ingestion only the grants below, and no other role any
CREATE POLICY "case_law_provision_extraction_owner_access" ON "case_law_provision_scope_transitions"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all, stella and stella_ingestion only the grants below, and no other role any
CREATE POLICY "case_law_provision_extraction_owner_access" ON "case_law_provision_extraction_revisions_registry"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all, stella and stella_ingestion only the grants below, and no other role any
CREATE POLICY "case_law_provision_extraction_owner_access" ON "case_law_provision_extraction_revisions"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all, stella and stella_ingestion only the grants below, and no other role any
CREATE POLICY "case_law_provision_extraction_owner_access" ON "case_law_provision_extractions"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE POLICY "case_law_global_access" ON "case_law_provision_scope_transitions"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_provision_scope_transitions"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_provision_extraction_revisions_registry"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_provision_extraction_revisions_registry"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_provision_extraction_revisions"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_provision_extraction_revisions"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_provision_extractions"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_provision_extractions"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

-- Scope rows have no policy and no grant: admission is read only through
-- case_law_provision_extraction_in_scope, so no second definition of "in
-- scope" can exist in application SQL.
REVOKE ALL PRIVILEGES ON TABLE "case_law_provision_extraction_scopes" FROM stella;--> statement-breakpoint

-- No application role may insert state: rows are created only by the
-- enqueue trigger and ensure_case_law_provision_extraction_state, which run
-- as the owner. Request code reads state; ingestion updates it.
GRANT SELECT
  ON TABLE
    "case_law_provision_scope_transitions",
    "case_law_provision_extraction_revisions_registry",
    "case_law_provision_extraction_revisions",
    "case_law_provision_extractions"
  TO "stella";--> statement-breakpoint
GRANT SELECT, UPDATE
  ON TABLE "case_law_provision_extractions" TO "stella_ingestion";--> statement-breakpoint
GRANT SELECT
  ON TABLE
    "case_law_provision_scope_transitions",
    "case_law_provision_extraction_revisions_registry",
    "case_law_provision_extraction_revisions"
  TO "stella_ingestion";--> statement-breakpoint

-- Scope rows are never deleted and their key never changes; every other
-- update is a transition, which advances the generation.
CREATE FUNCTION "guard_case_law_provision_extraction_scope"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provision extraction scope rows are never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."country" <> OLD."country" OR NEW."language" <> OLD."language" THEN
    RAISE EXCEPTION 'a provision extraction scope key never changes'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."generation" <= OLD."generation" THEN
    RAISE EXCEPTION 'a provision extraction scope transition must advance the generation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "case_law_provision_extraction_scope_guard"
BEFORE UPDATE OR DELETE ON "case_law_provision_extraction_scopes"
FOR EACH ROW EXECUTE FUNCTION "guard_case_law_provision_extraction_scope"();--> statement-breakpoint

-- A registered revision means one thing forever.
CREATE FUNCTION "refuse_case_law_provision_extraction_registry_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'registered provision extraction revisions are immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "case_law_provision_extraction_registry_immutable"
BEFORE UPDATE OR DELETE ON "case_law_provision_extraction_revisions_registry"
FOR EACH ROW EXECUTE FUNCTION "refuse_case_law_provision_extraction_registry_change"();--> statement-breakpoint

-- Neither the desired revision nor the current floor ever moves back, and a
-- jurisdiction's row is never removed: a rollback is a new, higher revision.
CREATE FUNCTION "guard_case_law_provision_extraction_revision"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provision extraction revision rows are never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."jurisdiction" <> OLD."jurisdiction"
     OR NEW."desired_revision" < OLD."desired_revision"
     OR NEW."min_current_revision" < OLD."min_current_revision" THEN
    RAISE EXCEPTION 'provision extraction revisions never decrease (% %/% to %/%)',
      OLD."jurisdiction", OLD."desired_revision", OLD."min_current_revision",
      NEW."desired_revision", NEW."min_current_revision"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW."changed_at" := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "case_law_provision_extraction_revision_guard"
BEFORE UPDATE OR DELETE ON "case_law_provision_extraction_revisions"
FOR EACH ROW EXECUTE FUNCTION "guard_case_law_provision_extraction_revision"();--> statement-breakpoint

CREATE FUNCTION "set_case_law_provision_extraction_revision"(
  target_jurisdiction varchar,
  desired integer,
  min_current integer
)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  INSERT INTO "case_law_provision_extraction_revisions" AS revision
    ("jurisdiction", "desired_revision", "min_current_revision")
  VALUES (target_jurisdiction, desired, min_current)
  ON CONFLICT ON CONSTRAINT "case_law_provision_extraction_revisions_pkey" DO UPDATE
  SET "desired_revision" = EXCLUDED."desired_revision",
      "min_current_revision" = EXCLUDED."min_current_revision";
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "set_case_law_provision_extraction_revision"(varchar, integer, integer)
  FROM PUBLIC;--> statement-breakpoint

-- The decision inputs extraction depends on, as one digest. The date is a
-- day count, never a formatted date, so no DateStyle or TimeZone setting can
-- change it; the infinities get string sentinels no finite date produces, and
-- NULL stays JSON null. Bump the tag with any change to this encoding.
CREATE FUNCTION "case_law_provision_extraction_input_digest"(decision "case_law_decisions")
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT sha256(convert_to(jsonb_build_array(
    'case-law-provision-extraction-input/1',
    decision."content_hash",
    CASE
      WHEN decision."decision_date" IS NULL THEN NULL
      WHEN isfinite(decision."decision_date")
        THEN to_jsonb(decision."decision_date" - DATE '2000-01-01')
      WHEN decision."decision_date" > DATE '2000-01-01' THEN to_jsonb('+infinity'::text)
      ELSE to_jsonb('-infinity'::text)
    END,
    decision."country",
    decision."language",
    decision."redacted_at" IS NULL
  )::text, 'UTF8'));
$$;--> statement-breakpoint

-- The one in-scope predicate: a matching scope row that is active. The
-- scope table grants application roles nothing, so this is its only read.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked below; it returns one boolean for the key it is given and writes nothing
CREATE FUNCTION "case_law_provision_extraction_in_scope"(
  decision_country varchar,
  decision_language varchar
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "case_law_provision_extraction_scopes" scope
    WHERE scope."country" = decision_country
      AND scope."language" = decision_language
      AND scope."status" = 'active'
  );
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "case_law_provision_extraction_in_scope"(varchar, varchar)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "case_law_provision_extraction_in_scope"(varchar, varchar)
  TO "stella_ingestion";--> statement-breakpoint

-- The lane a write from this session enqueues in. Bulk scripts set the
-- setting transaction-locally; once that transaction ends the setting reads
-- as an empty string, which, like unset, means fresh.
CREATE FUNCTION "case_law_provision_extraction_session_lane"()
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  requested text := nullif(current_setting('stella.provision_extraction_lane', true), '');
BEGIN
  IF requested IS NULL THEN
    RETURN 'fresh';
  END IF;
  IF requested IN ('fresh', 'repair', 'backfill') THEN
    RETURN requested;
  END IF;
  RAISE EXCEPTION 'stella.provision_extraction_lane must be fresh, repair or backfill, not %', requested
    USING ERRCODE = 'invalid_parameter_value';
END;
$$;--> statement-breakpoint

-- Outstanding work keeps the higher-priority of its lane and the incoming
-- one; completed work has no priority left to keep.
CREATE FUNCTION "case_law_provision_extraction_merged_lane"(
  held_lane text,
  held_due_at timestamptz,
  incoming_lane text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN held_due_at IS NOT NULL
      AND array_position(ARRAY['fresh', 'repair', 'backfill'], held_lane)
        < array_position(ARRAY['fresh', 'repair', 'backfill'], incoming_lane)
    THEN held_lane
    ELSE incoming_lane
  END;
$$;--> statement-breakpoint

-- Enqueue boundary. Fires on every insert and on any update of an input
-- column, whichever code path wrote it, and only ever enqueues: it never
-- deletes provision rows or publishes state. A changed input resets retries,
-- attempts and the lease, so a worker still holding the old lease fails
-- admission without spending an attempt. It runs as the owner because no
-- application role may insert state or touch scope rows.
-- stella-migration-safety: reviewed security-definer - trigger-only function has a fixed search path and PUBLIC execute is revoked below; it writes only the scope row and state row of the decision that fired it
CREATE FUNCTION "enqueue_case_law_provision_extraction"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  input_digest bytea := case_law_provision_extraction_input_digest(NEW);
BEGIN
  IF TG_OP = 'UPDATE' AND input_digest = case_law_provision_extraction_input_digest(OLD) THEN
    RETURN NULL;
  END IF;

  INSERT INTO "case_law_provision_extraction_scopes" ("country", "language", "status", "generation")
  VALUES (NEW."country", NEW."language", 'retired', 1)
  ON CONFLICT ON CONSTRAINT "case_law_provision_extraction_scopes_pkey" DO NOTHING;

  -- A statement of its own, so it reads the scope row a concurrent insert
  -- won with rather than this statement's snapshot.
  IF case_law_provision_extraction_in_scope(NEW."country", NEW."language") THEN
    INSERT INTO "case_law_provision_extractions" AS state (
      "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
    )
    VALUES (
      NEW."id", NEW."country", input_digest,
      case_law_provision_extraction_session_lane(), now(), 'input'
    )
    ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO UPDATE
    SET "jurisdiction" = EXCLUDED."jurisdiction",
        "desired_input_digest" = EXCLUDED."desired_input_digest",
        "lane" = case_law_provision_extraction_merged_lane(state."lane", state."due_at", EXCLUDED."lane"),
        "due_at" = EXCLUDED."due_at",
        "enqueue_reason" = EXCLUDED."enqueue_reason",
        "work_status" = 'eligible',
        "retry_not_before" = NULL,
        "failure_attempts" = 0,
        "transient_attempts" = 0,
        "last_failure_kind" = NULL,
        "last_failure_message" = NULL,
        "blocked_input_digest" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = now()
    WHERE state."desired_input_digest" IS DISTINCT FROM EXCLUDED."desired_input_digest";
  ELSE
    -- Out of scope now: a decision with state owes the cleanup of whatever
    -- it published. One without state has nothing to clean up.
    UPDATE "case_law_provision_extractions" AS state
    SET "jurisdiction" = NEW."country",
        "desired_input_digest" = input_digest,
        "lane" = case_law_provision_extraction_merged_lane(state."lane", state."due_at", 'repair'),
        "due_at" = now(),
        "enqueue_reason" = 'scope_retired',
        "work_status" = 'eligible',
        "retry_not_before" = NULL,
        "failure_attempts" = 0,
        "transient_attempts" = 0,
        "last_failure_kind" = NULL,
        "last_failure_message" = NULL,
        "blocked_input_digest" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = now()
    WHERE state."decision_id" = NEW."id"
      AND state."desired_input_digest" IS DISTINCT FROM input_digest;
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

-- The only other writer of state rows. It takes the decision row locks
-- first (level one of the provision lock order), then:
--   seed      creates missing state for in-scope decisions (backfill lane);
--   reconcile creates missing state and re-enqueues state whose desired
--             digest differs from the decision's (repair lane);
--   activate  does both and re-enqueues terminal work (the retirement
--             published it out of scope), but neither a current extraction
--             nor a blocked item whose input has not changed;
--   retire    enqueues cleanup for decisions with state whose key is no
--             longer in scope (repair lane).
-- Returns the number of state rows written. Runs as the owner, since no
-- application role may insert state; only ingestion may execute it.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked and granted to stella_ingestion only; it locks the named decisions first and writes only their state rows
CREATE FUNCTION "ensure_case_law_provision_extraction_state"(
  decision_ids uuid[],
  action text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  written integer;
BEGIN
  IF action IS NULL OR action NOT IN ('seed', 'reconcile', 'activate', 'retire') THEN
    RAISE EXCEPTION 'unknown provision extraction state action: %', action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1
  FROM "case_law_decisions" decision
  WHERE decision."id" = ANY (decision_ids)
  ORDER BY decision."id"
  FOR NO KEY UPDATE;

  CASE action
    WHEN 'seed' THEN
      INSERT INTO "case_law_provision_extractions" AS state (
        "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
      )
      SELECT decision."id", decision."country",
        case_law_provision_extraction_input_digest(decision), 'backfill', now(), 'seed'
      FROM "case_law_decisions" decision
      WHERE decision."id" = ANY (decision_ids)
        AND case_law_provision_extraction_in_scope(decision."country", decision."language")
      ORDER BY decision."id"
      ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO NOTHING;
    WHEN 'reconcile', 'activate' THEN
      INSERT INTO "case_law_provision_extractions" AS state (
        "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
      )
      SELECT decision."id", decision."country",
        case_law_provision_extraction_input_digest(decision),
        CASE action WHEN 'reconcile' THEN 'repair' ELSE 'backfill' END,
        now(),
        CASE action WHEN 'reconcile' THEN 'reconcile' ELSE 'scope_activated' END
      FROM "case_law_decisions" decision
      WHERE decision."id" = ANY (decision_ids)
        AND case_law_provision_extraction_in_scope(decision."country", decision."language")
      ORDER BY decision."id"
      ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO UPDATE
      SET "jurisdiction" = EXCLUDED."jurisdiction",
          "desired_input_digest" = EXCLUDED."desired_input_digest",
          "lane" = case_law_provision_extraction_merged_lane(state."lane", state."due_at", EXCLUDED."lane"),
          "due_at" = EXCLUDED."due_at",
          "enqueue_reason" = EXCLUDED."enqueue_reason",
          "work_status" = 'eligible',
          "retry_not_before" = NULL,
          "failure_attempts" = 0,
          "transient_attempts" = 0,
          "last_failure_kind" = NULL,
          "last_failure_message" = NULL,
          "blocked_input_digest" = NULL,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "updated_at" = now()
      WHERE CASE action
        WHEN 'reconcile' THEN
          state."desired_input_digest" IS DISTINCT FROM EXCLUDED."desired_input_digest"
        ELSE
          NOT (state."work_status" = 'blocked'
               AND state."blocked_input_digest" IS NOT DISTINCT FROM EXCLUDED."desired_input_digest")
          AND NOT (state."due_at" IS NOT NULL
                   AND state."enqueue_reason" IS NOT DISTINCT FROM 'scope_activated'
                   AND state."desired_input_digest" = EXCLUDED."desired_input_digest")
          AND NOT (state."due_at" IS NULL
                   AND coalesce(state."outcome" IN ('extracted_with_rows', 'extracted_zero'), false)
                   AND state."desired_input_digest" = EXCLUDED."desired_input_digest")
      END;
    WHEN 'retire' THEN
      UPDATE "case_law_provision_extractions" AS state
      SET "jurisdiction" = decision."country",
          "desired_input_digest" = case_law_provision_extraction_input_digest(decision),
          "lane" = case_law_provision_extraction_merged_lane(state."lane", state."due_at", 'repair'),
          "due_at" = now(),
          "enqueue_reason" = 'scope_retired',
          "work_status" = 'eligible',
          "retry_not_before" = NULL,
          "failure_attempts" = 0,
          "transient_attempts" = 0,
          "last_failure_kind" = NULL,
          "last_failure_message" = NULL,
          "blocked_input_digest" = NULL,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "updated_at" = now()
      FROM "case_law_decisions" decision
      WHERE state."decision_id" = decision."id"
        AND decision."id" = ANY (decision_ids)
        AND NOT case_law_provision_extraction_in_scope(decision."country", decision."language")
        AND NOT (state."due_at" IS NOT NULL
                 AND state."enqueue_reason" IS NOT DISTINCT FROM 'scope_retired'
                 AND state."desired_input_digest" = case_law_provision_extraction_input_digest(decision))
        AND NOT (state."due_at" IS NULL
                 AND state."terminal_reason" IS NOT DISTINCT FROM 'out_of_scope'
                 AND state."published_input_digest" IS NOT DISTINCT FROM case_law_provision_extraction_input_digest(decision));
  END CASE;

  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "ensure_case_law_provision_extraction_state"(uuid[], text)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "ensure_case_law_provision_extraction_state"(uuid[], text)
  TO "stella_ingestion";--> statement-breakpoint
REVOKE ALL ON FUNCTION "enqueue_case_law_provision_extraction"()
  FROM PUBLIC;--> statement-breakpoint

-- Its column list is exactly the digest's inputs; any other column of a
-- decision can change without paying for an enqueue.
CREATE TRIGGER "case_law_decision_provision_extraction_enqueue"
AFTER INSERT OR UPDATE OF "content_hash", "decision_date", "country", "language", "redacted_at"
ON "case_law_decisions"
FOR EACH ROW EXECUTE FUNCTION "enqueue_case_law_provision_extraction"();
