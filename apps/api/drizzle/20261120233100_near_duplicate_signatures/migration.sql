SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- MinHash signatures of extracted document text and their LSH band keys,
-- for near-duplicate detection within a workspace (#5324). Both cascade
-- with the entity version, so deleting a document deletes its signature.
CREATE TABLE "entity_version_minhash_signatures" (
	"entity_feature_gate" text DEFAULT 'pending' NOT NULL,
	"entity_feature_workspace_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"entity_version_id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"signature" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_version_minhash_signatures_length_check" CHECK (octet_length("signature") = 512)
);--> statement-breakpoint
ALTER TABLE "entity_version_minhash_signatures" ADD CONSTRAINT "entity_version_minhash_signatures_version_entity_workspace_fk" FOREIGN KEY ("entity_version_id","entity_id","workspace_id") REFERENCES "entity_versions"("id","entity_id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_signatures" ADD CONSTRAINT "entity_version_minhash_signatures_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_signatures" ADD CONSTRAINT "entity_version_minhash_signatures_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_signatures" ADD CONSTRAINT "entity_version_minhash_signatures_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "workspaces"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_signatures" ADD CONSTRAINT "entity_version_minhash_signatures_entity_workspace_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "entity_version_minhash_signatures_entity_workspace_idx" ON "entity_version_minhash_signatures" ("entity_id","workspace_id");--> statement-breakpoint
CREATE INDEX "entity_version_minhash_signatures_workspace_organization_idx" ON "entity_version_minhash_signatures" ("workspace_id","organization_id");--> statement-breakpoint
ALTER TABLE "entity_version_minhash_signatures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_signatures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "entity_version_minhash_signatures" TO stella;--> statement-breakpoint
CREATE POLICY "entity_version_minhash_signatures_owner" ON "entity_version_minhash_signatures" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.entity_version_minhash_signatures'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.entity_version_minhash_signatures'::regclass));--> statement-breakpoint
CREATE POLICY "entity_version_minhash_signatures_workspace_select" ON "entity_version_minhash_signatures" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "entity_version_minhash_signatures_workspace_insert" ON "entity_version_minhash_signatures" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "entity_version_minhash_signatures_workspace_update" ON "entity_version_minhash_signatures" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "entity_version_minhash_signatures_workspace_delete" ON "entity_version_minhash_signatures" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE TABLE "entity_version_minhash_bands" (
	"entity_feature_gate" text DEFAULT 'pending' NOT NULL,
	"entity_feature_workspace_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"entity_version_id" uuid NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"band_key" bigint NOT NULL,
	CONSTRAINT "entity_version_minhash_bands_pk" PRIMARY KEY("entity_version_id","band_key")
);--> statement-breakpoint
ALTER TABLE "entity_version_minhash_bands" ADD CONSTRAINT "entity_version_minhash_bands_signature_fk" FOREIGN KEY ("entity_version_id") REFERENCES "entity_version_minhash_signatures"("entity_version_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_bands" ADD CONSTRAINT "entity_version_minhash_bands_version_entity_workspace_fk" FOREIGN KEY ("entity_version_id","entity_id","workspace_id") REFERENCES "entity_versions"("id","entity_id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_bands" ADD CONSTRAINT "entity_version_minhash_bands_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_bands" ADD CONSTRAINT "entity_version_minhash_bands_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_bands" ADD CONSTRAINT "entity_version_minhash_bands_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "workspaces"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_bands" ADD CONSTRAINT "entity_version_minhash_bands_entity_workspace_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "entity_version_minhash_bands_lookup_idx" ON "entity_version_minhash_bands" ("workspace_id","band_key");--> statement-breakpoint
CREATE INDEX "entity_version_minhash_bands_entity_workspace_idx" ON "entity_version_minhash_bands" ("entity_id","workspace_id");--> statement-breakpoint
ALTER TABLE "entity_version_minhash_bands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entity_version_minhash_bands" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "entity_version_minhash_bands" TO stella;--> statement-breakpoint
CREATE POLICY "entity_version_minhash_bands_owner" ON "entity_version_minhash_bands" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.entity_version_minhash_bands'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.entity_version_minhash_bands'::regclass));--> statement-breakpoint
CREATE POLICY "entity_version_minhash_bands_workspace_select" ON "entity_version_minhash_bands" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "entity_version_minhash_bands_workspace_insert" ON "entity_version_minhash_bands" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "entity_version_minhash_bands_workspace_update" ON "entity_version_minhash_bands" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "entity_version_minhash_bands_workspace_delete" ON "entity_version_minhash_bands" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));
