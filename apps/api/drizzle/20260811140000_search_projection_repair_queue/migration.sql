-- stella-migration-safety: reviewed bulk-backfill - one-time seed of an empty work queue from the same drift predicates the drain uses; each SELECT is bounded by a projection-behind-source condition, writes only (kind, source id, organization id) work items and no tenant content, and the drain removes each row once its projection is rebuilt.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Where an entity, contact, or matter records that its search projection is
-- behind. Mutations write this row inside their own transaction, so the dirty
-- mark commits or rolls back with the edit that caused it; the projection
-- write that follows the commit only accelerates what this row already
-- guarantees.
--
-- One row per source: repeated edits collapse onto the same key. `revision`
-- is rewritten by every enqueue so the drain can remove or reschedule exactly
-- the revision it repaired and never swallow an edit that landed mid-repair.
--
-- `organization_id` carries tenancy for the row policies and nothing else. It
-- takes no foreign key on purpose: a mark whose source has since been deleted
-- is not an error to prevent but work to discard, and the drain discards it.
CREATE TABLE IF NOT EXISTS "search_projection_repair_queue" (
  "kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "revision" uuid NOT NULL,
  "enqueued_at" timestamptz DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "search_projection_repair_queue_pk" PRIMARY KEY ("kind", "source_id")
);--> statement-breakpoint

-- The drain's only read: rows whose retry time has arrived, oldest dirt
-- first.
CREATE INDEX IF NOT EXISTS "search_projection_repair_due_idx"
  ON "search_projection_repair_queue" ("next_attempt_at", "enqueued_at");--> statement-breakpoint

-- Added validating, not NOT VALID + VALIDATE: the table is created empty
-- above, so the scan is over no rows at this point, and the migrator wraps a
-- migration in one transaction in any case.
ALTER TABLE "search_projection_repair_queue"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "search_projection_repair_kind_values_check"
  CHECK ("kind" IN ('contact', 'entity', 'workspace'));--> statement-breakpoint

ALTER TABLE "search_projection_repair_queue"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "search_projection_repair_attempts_nonnegative_check"
  CHECK ("attempts" >= 0);--> statement-breakpoint

ALTER TABLE "search_projection_repair_queue"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Ordinary organization-scoped access: a tenant may only mark its own sources
-- dirty, and may only see the marks it made. The drain runs on the owner
-- connection, so repairs are unaffected by these policies.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "search_projection_repair_queue" TO stella;--> statement-breakpoint

CREATE POLICY "organization_select" ON "search_projection_repair_queue" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "search_projection_repair_queue" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "search_projection_repair_queue" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "search_projection_repair_queue" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

-- Seed the backlog this queue exists to retire.
--
-- Until now the only projection write was an unawaited post-commit call, so
-- every write lost to a restart left a source unfindable, or findable through
-- text from before its last edit, with nothing recording the debt. The queue
-- covers mutations from here on; these three scans hand it whatever earlier
-- losses left behind, using the same "projection missing or older than its
-- source" test the drain converges. Anything already current matches nothing
-- and is not enqueued.
--
-- The scans read every entity, contact, and matter once. Give them room
-- beyond the DDL budget above; they run once, on an otherwise idle table.
SET statement_timeout = '120s';--> statement-breakpoint

-- `upsert_search_document` stamps the projection with the entity's own
-- COALESCE(updated_at, created_at) under a compare-and-set on that value, so
-- the projection may trail the entity but never lead it. An entity with no
-- current version has no document to project.
INSERT INTO "search_projection_repair_queue"
  ("kind", "source_id", "organization_id", "revision")
SELECT 'entity', e.id, w.organization_id, gen_random_uuid()
FROM entities e
INNER JOIN workspaces w ON w.id = e.workspace_id
LEFT JOIN search_documents sd ON sd.entity_id = e.id
WHERE e.current_version_id IS NOT NULL
  AND w.status <> 'deleting'
  AND (
    sd.entity_id IS NULL
    OR sd.updated_at < COALESCE(e.updated_at, e.created_at)
  )
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The contact projection copies `contacts.updated_at` verbatim, which the
-- schema maintains on every write.
INSERT INTO "search_projection_repair_queue"
  ("kind", "source_id", "organization_id", "revision")
SELECT 'contact', c.id, c.organization_id, gen_random_uuid()
FROM contacts c
LEFT JOIN contact_search_documents csd ON csd.contact_id = c.id
WHERE csd.contact_id IS NULL
   OR csd.updated_at < c.updated_at
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- A matter has no `updated_at` of its own: its projection stores the latest
-- of its own timestamps and those of the contacts whose text it folds in.
-- Recomputing that maximum here is the closest a scan can get; it misses a
-- removed party, which is exactly the blind spot the queue closes going
-- forward, since `workspace_contacts` deletions now enqueue their matter.
INSERT INTO "search_projection_repair_queue"
  ("kind", "source_id", "organization_id", "revision")
SELECT 'workspace', w.id, w.organization_id, gen_random_uuid()
FROM workspaces w
LEFT JOIN workspace_search_documents wsd ON wsd.workspace_id = w.id
LEFT JOIN contacts client ON client.id = w.client_id
LEFT JOIN LATERAL (
  SELECT max(party.updated_at) AS updated_at
  FROM workspace_contacts wc
  INNER JOIN contacts party ON party.id = wc.contact_id
  WHERE wc.workspace_id = w.id
) parties ON TRUE
WHERE w.status <> 'deleting'
  AND (
    wsd.workspace_id IS NULL
    OR wsd.updated_at < GREATEST(
      w.created_at,
      w.last_activity_at,
      client.updated_at,
      parties.updated_at
    )
  )
ON CONFLICT DO NOTHING;
