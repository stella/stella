SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "agent_skill_revisions" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"skill_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"body" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "agent_skill_proposals" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"skill_id" uuid NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"body" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"author_id" text,
	"reviewer_id" text,
	"decided_at" timestamp with time zone,
	"result_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skill_proposals_status_check" CHECK ("status" IN ('draft', 'proposed', 'accepted', 'rejected')),
	CONSTRAINT "agent_skill_proposals_decision_timing_check" CHECK (("status" IN ('accepted', 'rejected')) = ("decided_at" IS NOT NULL)),
	CONSTRAINT "agent_skill_proposals_result_check" CHECK ("status" = 'accepted' OR "result_revision_id" IS NULL)
);--> statement-breakpoint

CREATE TABLE "agent_skill_comments" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"skill_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"proposal_id" uuid,
	"range_start" integer NOT NULL,
	"range_end" integer NOT NULL,
	"anchor_text" text NOT NULL,
	"body" text NOT NULL,
	"author_id" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skill_comments_range_check" CHECK ("range_start" >= 0 AND "range_end" >= "range_start")
);--> statement-breakpoint

ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_skill_id_agent_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "agent_skill_proposals" ADD CONSTRAINT "agent_skill_proposals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_proposals" ADD CONSTRAINT "agent_skill_proposals_skill_id_agent_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_proposals" ADD CONSTRAINT "agent_skill_proposals_base_revision_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."agent_skill_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_proposals" ADD CONSTRAINT "agent_skill_proposals_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_proposals" ADD CONSTRAINT "agent_skill_proposals_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_proposals" ADD CONSTRAINT "agent_skill_proposals_result_revision_fk" FOREIGN KEY ("result_revision_id") REFERENCES "public"."agent_skill_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "agent_skill_comments" ADD CONSTRAINT "agent_skill_comments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_comments" ADD CONSTRAINT "agent_skill_comments_skill_id_agent_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_comments" ADD CONSTRAINT "agent_skill_comments_revision_id_agent_skill_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."agent_skill_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_comments" ADD CONSTRAINT "agent_skill_comments_proposal_id_agent_skill_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."agent_skill_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_comments" ADD CONSTRAINT "agent_skill_comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_comments" ADD CONSTRAINT "agent_skill_comments_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "agent_skill_revisions_skill_number_uidx" ON "agent_skill_revisions" USING btree ("skill_id", "revision_number");--> statement-breakpoint
CREATE INDEX "agent_skill_revisions_org_skill_idx" ON "agent_skill_revisions" USING btree ("organization_id", "skill_id");--> statement-breakpoint
CREATE INDEX "agent_skill_proposals_skill_status_idx" ON "agent_skill_proposals" USING btree ("skill_id", "status");--> statement-breakpoint
CREATE INDEX "agent_skill_proposals_org_skill_idx" ON "agent_skill_proposals" USING btree ("organization_id", "skill_id");--> statement-breakpoint
CREATE INDEX "agent_skill_proposals_base_revision_idx" ON "agent_skill_proposals" USING btree ("base_revision_id");--> statement-breakpoint
CREATE INDEX "agent_skill_comments_skill_created_idx" ON "agent_skill_comments" USING btree ("skill_id", "created_at");--> statement-breakpoint
CREATE INDEX "agent_skill_comments_org_skill_idx" ON "agent_skill_comments" USING btree ("organization_id", "skill_id");--> statement-breakpoint
CREATE INDEX "agent_skill_comments_revision_idx" ON "agent_skill_comments" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "agent_skill_comments_proposal_idx" ON "agent_skill_comments" USING btree ("proposal_id");--> statement-breakpoint

ALTER TABLE "agent_skill_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_skill_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_skill_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "agent_skill_revision_select" ON "agent_skill_revisions" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_revisions.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_revision_insert" ON "agent_skill_revisions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_revisions.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_revision_update" ON "agent_skill_revisions" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_revisions.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
)) WITH CHECK ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_revisions.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_revision_delete" ON "agent_skill_revisions" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_revisions.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint

CREATE POLICY "agent_skill_proposal_select" ON "agent_skill_proposals" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_proposal_insert" ON "agent_skill_proposals" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_proposal_update" ON "agent_skill_proposals" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
)) WITH CHECK ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_proposal_delete" ON "agent_skill_proposals" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_proposals.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint

CREATE POLICY "agent_skill_comment_select" ON "agent_skill_comments" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_comment_insert" ON "agent_skill_comments" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_comment_update" ON "agent_skill_comments" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
)) WITH CHECK ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint
CREATE POLICY "agent_skill_comment_delete" ON "agent_skill_comments" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting('app.organization_id', true)) AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_comments.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting('app.user_id', true)))
  )
));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_skill_revisions" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_skill_proposals" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_skill_comments" TO stella;--> statement-breakpoint

-- Every body write on agent_skills records a revision here, so no code path
-- can skip history. Consecutive saves by the same user within ten minutes
-- coalesce into the latest revision (autosave writes every few hundred ms),
-- unless that revision is already referenced by a proposal or a comment, or
-- the caller set app.agent_skill_revision_mode = 'isolated' for the
-- transaction (used when accepting a proposal so the result is its own row).
-- stella-migration-safety: reviewed security-definer - trigger-only function has a fixed search path and PUBLIC execute is revoked below; it writes only the revision row for the skill row that fired it
CREATE FUNCTION "record_agent_skill_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor text := NULLIF(current_setting('app.user_id', true), '');
  -- current_setting(..., true) yields NULL when unset; coalesce keeps the
  -- boolean two-valued so NOT isolated is TRUE for ordinary transactions.
  isolated boolean := coalesce(current_setting('app.agent_skill_revision_mode', true), '') = 'isolated';
  latest record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.body IS NOT DISTINCT FROM OLD.body THEN
    RETURN NULL;
  END IF;

  SELECT id, revision_number, created_by, updated_at
    INTO latest
    FROM public.agent_skill_revisions
   WHERE skill_id = NEW.id
   ORDER BY revision_number DESC
   LIMIT 1
     FOR UPDATE;

  IF TG_OP = 'UPDATE'
     AND NOT isolated
     AND latest.id IS NOT NULL
     AND actor IS NOT NULL
     AND latest.created_by IS NOT DISTINCT FROM actor
     AND latest.updated_at > now() - interval '10 minutes'
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_skill_proposals pr
        WHERE pr.base_revision_id = latest.id OR pr.result_revision_id = latest.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_skill_comments c WHERE c.revision_id = latest.id
     )
  THEN
    UPDATE public.agent_skill_revisions
       SET body = NEW.body,
           content_hash = NEW.content_hash,
           updated_at = now()
     WHERE id = latest.id;
    RETURN NULL;
  END IF;

  INSERT INTO public.agent_skill_revisions
    (id, organization_id, skill_id, revision_number, body, content_hash, created_by)
  VALUES
    (gen_random_uuid(), NEW.organization_id, NEW.id,
     COALESCE(latest.revision_number, 0) + 1, NEW.body, NEW.content_hash, actor);
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "record_agent_skill_revision"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "agent_skills_record_revision_insert"
  AFTER INSERT ON "agent_skills"
  FOR EACH ROW
  EXECUTE FUNCTION "record_agent_skill_revision"();--> statement-breakpoint

CREATE TRIGGER "agent_skills_record_revision_update"
  AFTER UPDATE OF "body" ON "agent_skills"
  FOR EACH ROW
  EXECUTE FUNCTION "record_agent_skill_revision"();--> statement-breakpoint

-- Existing skills get revision 1 from their current body so history starts
-- complete. agent_skills is a small, org-authored table, so one statement is
-- bounded in practice.
-- stella-migration-safety: reviewed insert-select - one-time seed of revision 1 per existing skill; the table is small (hand-authored skills per organization) and the unique (skill_id, revision_number) index makes a rerun fail loudly instead of duplicating
INSERT INTO "agent_skill_revisions"
  ("id", "organization_id", "skill_id", "revision_number", "body", "content_hash", "created_by")
SELECT gen_random_uuid(), "organization_id", "id", 1, "body", "content_hash", NULL
  FROM "agent_skills";--> statement-breakpoint
