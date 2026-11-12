-- Internal conflict-of-interest checks. Additive: two new tables and two
-- read-only routines; nothing existing is altered.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "conflict_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"title" varchar(256),
	"run_by" text,
	"parties" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decision_revision" integer DEFAULT 0 NOT NULL,
	"decided_by" text,
	"decided_at" timestamptz,
	"decision_note" text,
	"consent_reference" varchar(512),
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_checks_id_org_unq" UNIQUE ("id", "organization_id"),
	CONSTRAINT "conflict_checks_decision_revision_check" CHECK ("conflict_checks"."decision_revision" >= 0),
	CONSTRAINT "conflict_checks_outcome_check" CHECK ("conflict_checks"."outcome" IN ('potential_conflict', 'incomplete', 'needs_review', 'information_only', 'no_matches')),
	CONSTRAINT "conflict_checks_decision_check" CHECK ("conflict_checks"."decision" IN ('pending', 'cleared', 'conflict', 'waived')),
	CONSTRAINT "conflict_checks_decision_fields_check" CHECK (("conflict_checks"."decision" = 'pending') = ("conflict_checks"."decided_at" IS NULL) AND ("conflict_checks"."decision" <> 'pending' OR ("conflict_checks"."decided_by" IS NULL AND "conflict_checks"."decision_note" IS NULL))),
	CONSTRAINT "conflict_checks_waiver_consent_check" CHECK (("conflict_checks"."decision" = 'waived') = ("conflict_checks"."consent_reference" IS NOT NULL) AND ("conflict_checks"."decision" <> 'waived' OR "conflict_checks"."decision_note" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_run_by_user_id_fk" FOREIGN KEY ("run_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "conflict_checks" ADD CONSTRAINT "conflict_checks_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "conflict_checks_org_created_idx" ON "conflict_checks" ("organization_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "conflict_checks_org_run_by_created_idx" ON "conflict_checks" ("organization_id", "run_by", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "conflict_checks_decided_by_idx" ON "conflict_checks" ("decided_by");--> statement-breakpoint
CREATE TABLE "conflict_check_matters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"conflict_check_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_check_matters_check_organization_fk" FOREIGN KEY ("conflict_check_id", "organization_id") REFERENCES "conflict_checks"("id", "organization_id") ON DELETE cascade,
	CONSTRAINT "conflict_check_matters_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE "conflict_check_matters" ADD CONSTRAINT "conflict_check_matters_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "conflict_check_matters_check_uidx" ON "conflict_check_matters" ("conflict_check_id");--> statement-breakpoint
CREATE INDEX "conflict_check_matters_org_workspace_idx" ON "conflict_check_matters" ("organization_id", "workspace_id");--> statement-breakpoint
ALTER TABLE "conflict_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_checks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_check_matters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_check_matters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "conflict_checks" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "conflict_check_matters" TO stella;--> statement-breakpoint
CREATE POLICY "conflict_check_owner" ON "conflict_checks" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.conflict_checks'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.conflict_checks'::regclass));--> statement-breakpoint
CREATE POLICY "conflict_check_select" ON "conflict_checks" AS PERMISSIVE FOR SELECT TO "stella" USING ((organization_id = (SELECT current_setting('app.organization_id', true)) AND (run_by = (SELECT current_setting('app.user_id', true)) OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin')) OR EXISTS (SELECT 1 FROM public.conflict_check_matters link WHERE link.conflict_check_id = conflict_checks.id AND link.organization_id = conflict_checks.organization_id))));--> statement-breakpoint
CREATE POLICY "conflict_check_insert" ON "conflict_checks" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((organization_id = (SELECT current_setting('app.organization_id', true)) AND run_by = (SELECT current_setting('app.user_id', true))));--> statement-breakpoint
CREATE POLICY "conflict_check_update" ON "conflict_checks" AS PERMISSIVE FOR UPDATE TO "stella" USING ((organization_id = (SELECT current_setting('app.organization_id', true)) AND (run_by = (SELECT current_setting('app.user_id', true)) OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))))) WITH CHECK ((organization_id = (SELECT current_setting('app.organization_id', true)) AND (run_by = (SELECT current_setting('app.user_id', true)) OR EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin')))));--> statement-breakpoint
CREATE POLICY "conflict_check_delete" ON "conflict_checks" AS PERMISSIVE FOR DELETE TO "stella" USING ((organization_id = (SELECT current_setting('app.organization_id', true)) AND EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))));--> statement-breakpoint
CREATE POLICY "conflict_check_matters_workspace_select" ON "public"."conflict_check_matters" AS PERMISSIVE FOR SELECT TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));--> statement-breakpoint
CREATE POLICY "conflict_check_matters_workspace_insert" ON "public"."conflict_check_matters" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));--> statement-breakpoint
CREATE POLICY "conflict_check_matters_workspace_update" ON "public"."conflict_check_matters" AS PERMISSIVE FOR UPDATE TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));--> statement-breakpoint
CREATE POLICY "conflict_check_matters_workspace_delete" ON "public"."conflict_check_matters" AS PERMISSIVE FOR DELETE TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Answers, for contacts every member can already read, which matters they appear in. A matter the caller may not open yields only its id and a severity computed here, never the contact's role or the matter's state; the caller must be a member allowed to run conflict checks in the organization the session names, and the search path is fixed.
CREATE FUNCTION public.stella_conflict_contact_links(org_id text, party_role text, contact_ids uuid[])
RETURNS TABLE (contact_id uuid, workspace_id uuid, accessible boolean, relation text, role text, matter_state text, severity text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF org_id IS DISTINCT FROM NULLIF(pg_catalog.current_setting('app.organization_id', true), '')
    OR NOT EXISTS (
      SELECT 1 FROM public.member m
      WHERE m.organization_id = org_id
        AND m.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')
        AND m.role IN ('owner', 'admin', 'member')
    ) THEN
    RAISE EXCEPTION 'conflict check links are not available to this session' USING ERRCODE = '42501';
  END IF;
  IF party_role IS NULL OR party_role NOT IN ('client', 'adverse', 'related') THEN
    RAISE EXCEPTION 'unknown conflict party role' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH links AS (
    SELECT w.client_id AS link_contact_id, w.id AS link_workspace_id, 'client'::text AS link_relation, NULL::text AS link_role, w.status AS link_status
    FROM public.workspaces w
    WHERE w.organization_id = org_id AND w.status <> 'deleting' AND w.client_id = ANY(contact_ids)
    UNION ALL
    SELECT wc.contact_id, w.id, 'matter_role'::text, wc.role, w.status
    FROM public.workspace_contacts wc
    JOIN public.workspaces w ON w.id = wc.workspace_id AND w.organization_id = wc.organization_id
    WHERE wc.organization_id = org_id AND w.status <> 'deleting' AND wc.contact_id = ANY(contact_ids)
  ),
  classified AS (
    SELECT l.*,
      l.link_workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) AS link_visible,
      CASE
        WHEN l.link_relation = 'client' THEN
          CASE party_role WHEN 'client' THEN 'information' WHEN 'adverse' THEN 'potential_conflict' ELSE 'needs_review' END
        WHEN l.link_role = 'opposing_party' THEN
          CASE party_role
            WHEN 'client' THEN CASE WHEN l.link_status = 'active' THEN 'potential_conflict' ELSE 'needs_review' END
            WHEN 'adverse' THEN 'information'
            ELSE 'needs_review'
          END
        WHEN l.link_role IN ('judge', 'mediator') THEN 'information'
        WHEN l.link_role IN ('co_counsel', 'opposing_counsel', 'witness', 'expert_witness', 'third_party', 'other') THEN
          CASE party_role WHEN 'related' THEN 'information' ELSE 'needs_review' END
        -- A role this routine does not know yet is never read as harmless.
        ELSE 'needs_review'
      END AS link_severity
    FROM links l
  )
  -- A matter the caller may not open reports the most severe classification
  -- over every party role, so submitting the same contact under each role
  -- cannot tell a client from an opponent or a witness.
  SELECT c.link_contact_id, c.link_workspace_id, c.link_visible,
    CASE WHEN c.link_visible THEN c.link_relation END,
    CASE WHEN c.link_visible THEN c.link_role END,
    CASE WHEN c.link_visible THEN CASE WHEN c.link_status = 'active' THEN 'open' ELSE 'closed' END END,
    CASE
      WHEN c.link_visible THEN c.link_severity
      WHEN c.link_relation = 'client' THEN 'potential_conflict'
      WHEN c.link_role = 'opposing_party' AND c.link_status = 'active' THEN 'potential_conflict'
      WHEN c.link_role IN ('judge', 'mediator') THEN 'information'
      ELSE 'needs_review'
    END
  FROM classified c;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_conflict_contact_links(text, text, uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_conflict_contact_links(text, text, uuid[]) TO stella;--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - For matter ids a stored check recorded, answers whether each still exists, whether the caller may open it, and, only when the caller may not, whom to ask (the matter lead, else the client's responsible lawyer, while still a member). It discloses nothing else, requires a member allowed to run conflict checks in the organization the session names, and fixes the search path.
CREATE FUNCTION public.stella_conflict_matter_contacts(org_id text, workspace_ids uuid[])
RETURNS TABLE (workspace_id uuid, accessible boolean, contact_user_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF org_id IS DISTINCT FROM NULLIF(pg_catalog.current_setting('app.organization_id', true), '')
    OR NOT EXISTS (
      SELECT 1 FROM public.member m
      WHERE m.organization_id = org_id
        AND m.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')
        AND m.role IN ('owner', 'admin', 'member')
    ) THEN
    RAISE EXCEPTION 'conflict check matters are not available to this session' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH matters AS (
    SELECT w.id AS matter_id,
      w.id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) AS matter_visible,
      w.lead_user_id AS lead_id,
      client.responsible_attorney_id AS attorney_id
    FROM public.workspaces w
    LEFT JOIN public.contacts client ON client.id = w.client_id AND client.organization_id = w.organization_id
    WHERE w.organization_id = org_id AND w.status <> 'deleting' AND w.id = ANY(workspace_ids)
  )
  SELECT mt.matter_id, mt.matter_visible,
    CASE WHEN mt.matter_visible THEN NULL ELSE (
      SELECT candidate.user_id
      FROM (VALUES (1, mt.lead_id), (2, mt.attorney_id)) AS candidate(rank, user_id)
      WHERE candidate.user_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.member m WHERE m.organization_id = org_id AND m.user_id = candidate.user_id)
      ORDER BY candidate.rank
      LIMIT 1
    ) END
  FROM matters mt;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_conflict_matter_contacts(text, uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_conflict_matter_contacts(text, uuid[]) TO stella;
