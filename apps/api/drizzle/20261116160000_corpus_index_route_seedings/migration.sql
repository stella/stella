-- requires: 20261116020000_corpus_projection_fault_immutable
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The seeding walk of one corpus generation: one pass over the family's
-- canonical rows in id order that gives each row the generation routes a
-- desired state. The cursor and counts move in the transaction that seeds the
-- page they describe. A status change that takes a generation out of the
-- active set, or back into it, deletes the row (trigger at the end); a
-- deleted registration cascades.
CREATE TABLE IF NOT EXISTS "corpus_index_generation_seeding_passes" (
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "pass_number" bigint DEFAULT 1 NOT NULL,
  "pass_started_at" timestamptz NOT NULL,
  "route_index_ids" varchar(64)[] NOT NULL,
  "route_jurisdictions" varchar(3)[] NOT NULL,
  "after_entity_id" uuid,
  "walked_count" bigint DEFAULT 0 NOT NULL,
  "seeded_count" bigint DEFAULT 0 NOT NULL,
  "deferred_count" bigint DEFAULT 0 NOT NULL,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_generation_seeding_passes_pkey"
    PRIMARY KEY ("family", "generation"),
  -- Declared with the table, which is created empty: nothing to validate.
  -- The referenced registry holds a handful of rows.
  CONSTRAINT "corpus_index_generation_seeding_passes_generation_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "public"."corpus_index_generations"("family", "generation")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "corpus_index_generation_seeding_passes_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_generation_seeding_passes_counts"
    CHECK ("pass_number" > 0 AND "walked_count" >= 0 AND "seeded_count" >= 0 AND "deferred_count" >= 0 AND "seeded_count" + "deferred_count" <= "walked_count"),
  CONSTRAINT "corpus_index_generation_seeding_passes_completed_shape"
    CHECK ("completed_at" IS NULL OR "completed_at" >= "pass_started_at")
);--> statement-breakpoint

-- One route of a generation that a completed seeding pass covered. A route
-- with no row is unseeded by construction.
CREATE TABLE IF NOT EXISTS "corpus_index_route_seedings" (
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "index_id" varchar(64) NOT NULL,
  "jurisdictions" varchar(3)[] NOT NULL,
  "pass_number" bigint NOT NULL,
  "pass_started_at" timestamptz NOT NULL,
  "seeded_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_route_seedings_pkey"
    PRIMARY KEY ("family", "generation", "index_id"),
  -- Both tables are created empty in this migration.
  CONSTRAINT "corpus_index_route_seedings_pass_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "public"."corpus_index_generation_seeding_passes"("family", "generation")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "corpus_index_route_seedings_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_route_seedings_index_shape"
    CHECK ("index_id" ~ '^[a-z0-9_]+$'),
  CONSTRAINT "corpus_index_route_seedings_pass_shape"
    CHECK ("pass_number" > 0 AND "seeded_at" >= "pass_started_at")
);--> statement-breakpoint


-- Row security is forced, so the owner (the maintenance lane's root handle,
-- which runs the operator `seed` command and the generation lifecycle) and
-- the owner's trigger function below are bound by policy too: the owner
-- policy names the owner, the reader may read and ingestion may write.
ALTER TABLE "corpus_index_generation_seeding_passes"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_generation_seeding_passes"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_route_seedings"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_route_seedings"
  FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_global_access"
  ON "corpus_index_generation_seeding_passes"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_generation_seeding_passes"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "corpus_index_generation_seeding_pass_owner_access"
  ON "corpus_index_generation_seeding_passes"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_generation_seeding_passes'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_generation_seeding_passes'::regclass));--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_route_seedings"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_route_seedings"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "corpus_index_route_seeding_owner_access"
  ON "corpus_index_route_seedings"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_route_seedings'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_route_seedings'::regclass));--> statement-breakpoint

-- The seeding walk writes both; a generation leaving or re-entering the
-- active set deletes its pass (the trigger below), and the route rows cascade.
GRANT SELECT ON TABLE "corpus_index_generation_seeding_passes" TO stella;--> statement-breakpoint
GRANT SELECT ON TABLE "corpus_index_route_seedings" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "corpus_index_generation_seeding_passes"
  TO stella_ingestion;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "corpus_index_route_seedings"
  TO stella_ingestion;--> statement-breakpoint

-- A seeding pass describes a generation only while the desired writers keep
-- projecting every change into it, which they do exactly while its status is
-- in the active set (CORPUS_INDEX_ACTIVE_GENERATION_STATUSES: building,
-- serving). Any status change that moves the generation out of that set, or
-- back into it, deletes its pass in the same statement, whichever code or
-- release made the change: a generation that comes back from retiring missed
-- the changes made while it was out, so it needs a new pass. A change within
-- the set (a flip between building and serving) keeps it. The function runs
-- as the tables' owner, so a role that may change a generation's status
-- needs no privilege on the seeding tables.
-- stella-migration-safety: reviewed security-definer - trigger-only function with a fixed search path and PUBLIC execute revoked below; it only deletes the seeding pass of the generation whose status changed
CREATE FUNCTION "forget_corpus_index_generation_seeding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  DELETE FROM public.corpus_index_generation_seeding_passes
   WHERE family = NEW.family
     AND generation = NEW.generation;
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "forget_corpus_index_generation_seeding"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_index_generations_forget_seeding"
  AFTER UPDATE OF "status" ON "corpus_index_generations"
  FOR EACH ROW
  WHEN ((OLD."status" IN ('building', 'serving'))
    IS DISTINCT FROM (NEW."status" IN ('building', 'serving')))
  EXECUTE FUNCTION "forget_corpus_index_generation_seeding"();
