SET LOCAL lock_timeout = '240s';--> statement-breakpoint
SET LOCAL statement_timeout = '250s';--> statement-breakpoint

-- The triggers below need a moment alone with the revision table, and a
-- projection writer holds its row locks until it commits. Taking the
-- mutation fence first lets running writers finish and queues new ones, so
-- the moment arrives; the short bounds below cover the DDL itself.
SELECT "lock_corpus_projection_mutations_exclusive"();--> statement-breakpoint

SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The settlement queue: one row per delete task of one index whose revisions
-- may still wait in `cleanup_committed`. The revisions' rows stay the truth;
-- a task row only says where to look, so the settlement claim walks a few
-- task rows instead of grouping the whole committed backlog. Written by the
-- triggers below in the transaction that stamps a delete receipt; the online
-- repair `corpus-projection-delete-tasks` adds the tasks recorded before the
-- triggers existed.
CREATE TABLE "corpus_index_projection_delete_tasks" (
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "index_id" varchar(64) NOT NULL,
  "delete_opstamp" bigint NOT NULL,
  "task_created_at" timestamptz NOT NULL,
  "cleanup_started_at" timestamptz NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_projection_delete_tasks_pkey"
    PRIMARY KEY ("family", "generation", "index_id", "delete_opstamp"),
  CONSTRAINT "corpus_index_projection_delete_tasks_generation_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "corpus_index_generations" ("family", "generation")
    ON DELETE CASCADE,
  CONSTRAINT "corpus_index_projection_delete_tasks_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_projection_delete_tasks_opstamp_nonnegative"
    CHECK ("delete_opstamp" >= 0),
  CONSTRAINT "corpus_index_projection_delete_tasks_lease_shape"
    CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
);--> statement-breakpoint

-- The claim's walk: one index's tasks, oldest cleanup first.
CREATE INDEX "corpus_index_projection_delete_tasks_claim_idx"
  ON "corpus_index_projection_delete_tasks" USING btree
  ("family", "generation", "index_id", "cleanup_started_at", "delete_opstamp");--> statement-breakpoint

ALTER TABLE "corpus_index_projection_delete_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "corpus_index_projection_delete_tasks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Row security is forced, so the owner's trigger functions are bound by policy
-- too. The owner role is named per deployment, so the policy cannot name it;
-- table privileges decide who reaches the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: only the owner's trigger function and online repair insert, the ingestion role's settlement reads, leases and deletes, and the request role is granted nothing
CREATE POLICY "corpus_index_projection_delete_tasks_owner_access"
  ON "corpus_index_projection_delete_tasks"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "corpus_index_projection_delete_tasks"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "corpus_index_projection_delete_tasks" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "corpus_index_projection_delete_tasks" FROM stella;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "corpus_index_projection_delete_tasks" TO stella_ingestion;--> statement-breakpoint
GRANT UPDATE ("lease_token", "lease_expires_at")
  ON TABLE "corpus_index_projection_delete_tasks" TO stella_ingestion;--> statement-breakpoint

-- A revision gained a delete receipt with its task instant: its task is in the
-- queue. Runs as its owner, so the writers of the revision table need no
-- insert privilege on the queue. A task already queued keeps its row and its
-- lease; it only moves earlier when this revision started its cleanup earlier.
-- stella-migration-safety: reviewed security-definer - trigger-only function with a fixed search path and PUBLIC execute revoked below; it only upserts the receipt's delete task into the settlement queue
CREATE FUNCTION "queue_corpus_projection_delete_task"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.corpus_index_projection_delete_tasks AS task
    (family, generation, index_id, delete_opstamp, task_created_at,
     cleanup_started_at)
  VALUES
    (NEW.family, NEW.generation, NEW.index_id, NEW.delete_opstamp,
     NEW.delete_task_created_at, NEW.cleanup_started_at)
  ON CONFLICT ON CONSTRAINT corpus_index_projection_delete_tasks_pkey DO UPDATE
    SET cleanup_started_at = LEAST(task.cleanup_started_at, EXCLUDED.cleanup_started_at),
        task_created_at = LEAST(task.task_created_at, EXCLUDED.task_created_at)
    WHERE task.cleanup_started_at > EXCLUDED.cleanup_started_at
       OR task.task_created_at > EXCLUDED.task_created_at;
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "queue_corpus_projection_delete_task"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_projection_intents_delete_task_insert"
AFTER INSERT ON "corpus_index_projection_intents"
FOR EACH ROW
WHEN (
  NEW.status = 'cleanup_committed'
  AND NEW.delete_opstamp IS NOT NULL
  AND NEW.delete_task_created_at IS NOT NULL
)
EXECUTE FUNCTION "queue_corpus_projection_delete_task"();--> statement-breakpoint

CREATE TRIGGER "corpus_projection_intents_delete_task_update"
AFTER UPDATE OF "status", "delete_opstamp", "delete_task_created_at"
ON "corpus_index_projection_intents"
FOR EACH ROW
WHEN (
  NEW.status = 'cleanup_committed'
  AND NEW.delete_opstamp IS NOT NULL
  AND NEW.delete_task_created_at IS NOT NULL
  AND (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.delete_opstamp IS DISTINCT FROM NEW.delete_opstamp
    OR OLD.delete_task_created_at IS DISTINCT FROM NEW.delete_task_created_at
  )
)
EXECUTE FUNCTION "queue_corpus_projection_delete_task"();
