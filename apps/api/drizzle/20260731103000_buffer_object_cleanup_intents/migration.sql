SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "buffer_object_cleanup_intents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "object_key" text NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "buffer_object_cleanup_attempt_count_nonnegative_check"
    CHECK ("attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "buffer_object_cleanup_schedule_idx"
  ON "buffer_object_cleanup_intents" ("next_attempt_at", "id");
--> statement-breakpoint
-- Tombstones contain storage keys and are root-worker-readable only. Scoped
-- lifecycle deletion may insert one for its active tenant; the original scoped
-- writer may delete it after its PUT settles and exact-key cleanup succeeds.
ALTER TABLE "buffer_object_cleanup_intents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "buffer_object_cleanup_intents" FROM stella;
--> statement-breakpoint
GRANT INSERT, DELETE ON TABLE "buffer_object_cleanup_intents" TO stella;
--> statement-breakpoint
-- The writer's DELETE predicate references only the opaque intent id. Grant
-- column-level read rather than exposing retained tenant storage keys.
GRANT SELECT ("id") ON TABLE "buffer_object_cleanup_intents" TO stella;
--> statement-breakpoint
CREATE POLICY "buffer_object_cleanup_insert"
  ON "buffer_object_cleanup_intents"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(
      COALESCE(
        NULLIF(
          (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
          ''
        )::uuid[],
        ARRAY[]::uuid[]
      )
    ) THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
--> statement-breakpoint
CREATE POLICY "buffer_object_cleanup_delete"
  ON "buffer_object_cleanup_intents"
  AS PERMISSIVE FOR DELETE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(
      COALESCE(
        NULLIF(
          (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
          ''
        )::uuid[],
        ARRAY[]::uuid[]
      )
    ) THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
