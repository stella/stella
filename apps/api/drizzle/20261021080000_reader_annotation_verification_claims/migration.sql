-- requires: 20260913210000_legal_reader_annotations
-- requires: 20260925220000_legal_list_verifications
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A reviewer can now comment on one claim of a matter's document
-- verification, on the same reader-annotation rows the case-law and statute
-- readers write. A claim's comment is matter content, so it names its matter,
-- run and claim, and is visible only while the caller can see that claim.
--
-- Additive for the rollout: the new columns are nullable and every row the
-- previous build writes leaves them null, which both new checks accept. The
-- checks and the matter key are added NOT VALID; the post-deploy online phase
-- validates them and builds the claim index (apps/api/src/db/online-migrations.ts).
ALTER TABLE "legal_reader_annotations"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
  ADD COLUMN IF NOT EXISTS "verification_run_id" uuid,
  ADD COLUMN IF NOT EXISTS "verification_claim_id" uuid;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - replaced in the same transaction by the same check over a superset of target types
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT IF EXISTS "legal_reader_annotations_target_type_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_target_type_values"
  CHECK ("target_type" IN ('decision', 'statute', 'verification-claim')) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT IF EXISTS "legal_reader_annotations_verification_claim_shape";--> statement-breakpoint

-- A claim's comment carries its matter, run and claim; nothing else does.
ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_verification_claim_shape"
  CHECK (
    ("target_type" = 'verification-claim') = ("workspace_id" IS NOT NULL AND "verification_run_id" IS NOT NULL AND "verification_claim_id" IS NOT NULL)
    AND ("verification_claim_id" IS NULL OR "verification_claim_id" = "target_id")
  ) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT IF EXISTS "legal_reader_annotations_workspace_organization_fk";--> statement-breakpoint

-- The matter is held to the comment's organization, and deleting it deletes
-- the comments on its claims.
ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "workspaces"("id", "organization_id")
  ON DELETE CASCADE NOT VALID;--> statement-breakpoint

-- Whether the caller can see a claim: SECURITY INVOKER, so the claim's own
-- policies (matter access, the verification's feature fence) decide. Positional
-- parameters, because the claims carry columns of the same names.
CREATE OR REPLACE FUNCTION public.legal_reader_annotation_claim_visible(uuid, uuid, uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.legal_list_claims claim
    WHERE claim.id = $1 AND claim.run_id = $2 AND claim.workspace_id = $3
  )
$$;--> statement-breakpoint

-- The same test for a new comment, holding the claim FOR KEY SHARE until the
-- insert's transaction ends. A deletion of the claim then either waits for
-- the comment, whose cleanup trigger removes it once committed, or has
-- already removed the claim and the insert is refused: no comment outlives
-- its claim. VOLATILE because it locks; only the insert check calls it.
CREATE OR REPLACE FUNCTION public.legal_reader_annotation_claim_held(uuid, uuid, uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.legal_list_claims claim
    WHERE claim.id = $1 AND claim.run_id = $2 AND claim.workspace_id = $3
    FOR KEY SHARE
  )
$$;--> statement-breakpoint

-- Every application policy now also holds a note that sits in a matter to
-- that matter: the caller must be able to open it, and the claim the note is
-- on must be visible to them (the claim's own policies carry the matter's
-- walls and the verification's feature fence). A note without a matter, which
-- is every row the previous build writes, reads exactly as before.
-- stella-migration-safety: reviewed alter-policy - narrows the authored-note read policy with the optional matter and claim check; rows without a workspace are admitted as before
ALTER POLICY "organization_select" ON "legal_reader_annotations"
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND (workspace_id IS NULL OR (CASE
      WHEN workspace_id = ANY(
        COALESCE(
          NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE workspace_id IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END AND public.legal_reader_annotation_claim_visible("legal_reader_annotations"."verification_claim_id", "legal_reader_annotations"."verification_run_id", "legal_reader_annotations"."workspace_id")))
    AND (visibility = 'shared' OR user_id = (SELECT current_setting('app.user_id', true)))
  );--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - narrows the author insert check with the optional matter check and holds the claim for the insert
ALTER POLICY "author_insert" ON "legal_reader_annotations"
  WITH CHECK (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND (workspace_id IS NULL OR (CASE
      WHEN workspace_id = ANY(
        COALESCE(
          NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE workspace_id IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END AND public.legal_reader_annotation_claim_held("legal_reader_annotations"."verification_claim_id", "legal_reader_annotations"."verification_run_id", "legal_reader_annotations"."workspace_id")))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - narrows the author update policy with the same optional matter and claim check
ALTER POLICY "author_update" ON "legal_reader_annotations"
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND (workspace_id IS NULL OR (CASE
      WHEN workspace_id = ANY(
        COALESCE(
          NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE workspace_id IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END AND public.legal_reader_annotation_claim_visible("legal_reader_annotations"."verification_claim_id", "legal_reader_annotations"."verification_run_id", "legal_reader_annotations"."workspace_id")))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - narrows the author delete policy with the same optional matter and claim check
ALTER POLICY "author_delete" ON "legal_reader_annotations"
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND (workspace_id IS NULL OR (CASE
      WHEN workspace_id = ANY(
        COALESCE(
          NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE workspace_id IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END AND public.legal_reader_annotation_claim_visible("legal_reader_annotations"."verification_claim_id", "legal_reader_annotations"."verification_run_id", "legal_reader_annotations"."workspace_id")))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

-- The review reset clears every author's notes as the table owner, as it does
-- for the reader's answers, now that the table forces its policies.
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP POLICY IF EXISTS "review_reset_owner_select" ON "legal_reader_annotations";--> statement-breakpoint

CREATE POLICY "review_reset_owner_select" ON "legal_reader_annotations" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP POLICY IF EXISTS "review_reset_owner_delete" ON "legal_reader_annotations";--> statement-breakpoint

CREATE POLICY "review_reset_owner_delete" ON "legal_reader_annotations" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint

-- The claim-cleanup trigger runs as the owner and removes every author's
-- comments on the claims a statement deleted, only during trigger execution.
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP POLICY IF EXISTS "claim_cleanup_owner_select" ON "legal_reader_annotations";--> statement-breakpoint

CREATE POLICY "claim_cleanup_owner_select" ON "legal_reader_annotations" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass) AND pg_catalog.pg_trigger_depth() > 0 AND verification_claim_id IS NOT NULL
);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP POLICY IF EXISTS "claim_cleanup_owner_delete" ON "legal_reader_annotations";--> statement-breakpoint

CREATE POLICY "claim_cleanup_owner_delete" ON "legal_reader_annotations" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass) AND pg_catalog.pg_trigger_depth() > 0 AND verification_claim_id IS NOT NULL
);--> statement-breakpoint

-- Reader notes now hold matter content, so the owner is held to the policies
-- too; the owner policies above are the only rows it reaches.
ALTER TABLE "legal_reader_annotations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- A claim is deleted with its run, its document or its matter. Its comments
-- go with it, whoever wrote them: the claim is not a foreign key here (a key
-- to the fenced claims would enrol reader notes in the entity gate graph), so
-- one statement-level trigger does what the cascade would.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; deletes only reader comments whose claim the firing statement deleted, matched on matter and claim through the partial index
CREATE OR REPLACE FUNCTION "legal_reader_annotations_drop_claim_comments"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.legal_reader_annotations annotation
  USING removed_claims claim
  WHERE annotation.workspace_id = claim.workspace_id
    AND annotation.verification_claim_id = claim.id;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "legal_reader_annotations_drop_claim_comments"() FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - Drops only the trigger the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP TRIGGER IF EXISTS "legal_list_claims_drop_reader_comments" ON "legal_list_claims";--> statement-breakpoint

CREATE TRIGGER "legal_list_claims_drop_reader_comments"
AFTER DELETE ON "legal_list_claims"
REFERENCING OLD TABLE AS removed_claims
FOR EACH STATEMENT EXECUTE FUNCTION "legal_reader_annotations_drop_claim_comments"();--> statement-breakpoint
