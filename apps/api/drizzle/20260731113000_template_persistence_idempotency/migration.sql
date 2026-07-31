SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "template_persistence_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "request_fingerprint" varchar(64) NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "claim_token" uuid NOT NULL,
  "claimed_at" timestamptz DEFAULT now() NOT NULL,
  "result" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "template_persistence_requests_key_nonempty_check"
    CHECK (length("idempotency_key") > 0),
  CONSTRAINT "template_persistence_requests_fingerprint_check"
    CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "template_persistence_requests_state_check"
    CHECK (
      (
        "status" = 'pending'
        AND "result" IS NULL
        AND "completed_at" IS NULL
      ) OR (
        "status" = 'completed'
        AND "result" IS NOT NULL
        AND "completed_at" IS NOT NULL
      )
    )
);
--> statement-breakpoint
ALTER TABLE "template_persistence_requests"
  ADD CONSTRAINT "template_persistence_requests_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "template_persistence_requests"
  ADD CONSTRAINT "template_persistence_requests_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "template_persistence_requests"
  ADD CONSTRAINT "template_persistence_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "template_persistence_requests_org_user_key_uidx"
  ON "template_persistence_requests"
  ("organization_id", "user_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "template_persistence_requests_workspace_created_idx"
  ON "template_persistence_requests" ("workspace_id", "created_at");
--> statement-breakpoint
ALTER TABLE "template_persistence_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "template_persistence_requests" TO stella;
--> statement-breakpoint
CREATE POLICY "template_persistence_requests_workspace_select"
  ON "template_persistence_requests"
  AS PERMISSIVE FOR SELECT TO stella
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
--> statement-breakpoint
CREATE POLICY "template_persistence_requests_workspace_insert"
  ON "template_persistence_requests"
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
CREATE POLICY "template_persistence_requests_workspace_update"
  ON "template_persistence_requests"
  AS PERMISSIVE FOR UPDATE TO stella
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
--> statement-breakpoint
CREATE POLICY "template_persistence_requests_workspace_delete"
  ON "template_persistence_requests"
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
