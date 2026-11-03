-- requires: 20261022130000_account_export_annotation_authorship
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A reader can now highlight and comment on a matter document's PDF, on the
-- same reader-annotation rows the case-law reader and the claim comments
-- write. Such a mark is matter content: it names its matter, the document,
-- the file field it was placed on (`target_id`), the page (`block_anchor_id`
-- `page-<n>`) and the digest of that page's extracted text, and is visible
-- only while the caller can see that file of a live version.
--
-- Additive for the rollout: the new columns are nullable and every row the
-- previous build writes leaves them null, which the new check accepts. The
-- checks are added NOT VALID; the post-deploy online phase validates them and
-- builds the document index (apps/api/src/db/online-migrations.ts).
ALTER TABLE "legal_reader_annotations"
  ADD COLUMN IF NOT EXISTS "entity_id" uuid,
  ADD COLUMN IF NOT EXISTS "page_text_sha256" varchar(64);--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - replaced in the same transaction by the same check over a superset of target types
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT IF EXISTS "legal_reader_annotations_target_type_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_target_type_values"
  CHECK ("target_type" IN ('decision', 'statute', 'verification-claim', 'matter-document')) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT IF EXISTS "legal_reader_annotations_matter_document_shape";--> statement-breakpoint

-- A matter document's mark carries its document, page and page digest;
-- nothing else does.
ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_matter_document_shape"
  CHECK (
    ("target_type" = 'matter-document') = ("entity_id" IS NOT NULL AND "page_text_sha256" IS NOT NULL)
    AND ("target_type" <> 'matter-document' OR ("workspace_id" IS NOT NULL AND "block_anchor_id" ~ '^page-[1-9][0-9]{0,5}$' AND "page_text_sha256" ~ '^[0-9a-f]{64}$'))
  ) NOT VALID;--> statement-breakpoint

-- Whether the caller can see the file a mark sits on: the field, of a live
-- version of the named document, in the mark's matter. SECURITY INVOKER, so
-- the field's and the version's own policies (matter access, the entity
-- feature fence) decide. Positional parameters, as the claim check uses.
CREATE OR REPLACE FUNCTION public.legal_reader_annotation_document_visible(uuid, uuid, uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.fields field
    JOIN public.entity_versions version ON version.id = field.entity_version_id
    WHERE field.id = $1
      AND field.workspace_id = $3
      AND version.entity_id = $2
      AND version.workspace_id = $3
      AND version.deleted_at IS NULL
  )
$$;--> statement-breakpoint

-- The same test for a new mark, holding the field FOR KEY SHARE until the
-- insert's transaction ends. Deleting the document then either waits for the
-- mark, whose cleanup trigger removes it once committed, or has already
-- removed the field and the insert is refused: no mark outlives its document.
-- VOLATILE because it locks; only the insert check calls it.
CREATE OR REPLACE FUNCTION public.legal_reader_annotation_document_held(uuid, uuid, uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.fields field
    JOIN public.entity_versions version ON version.id = field.entity_version_id
    WHERE field.id = $1
      AND field.workspace_id = $3
      AND version.entity_id = $2
      AND version.workspace_id = $3
      AND version.deleted_at IS NULL
    FOR KEY SHARE OF field
  )
$$;--> statement-breakpoint

-- Every application policy now holds a note in a matter to the row it sits
-- on, by its target: a claim's comment to its claim, as before, and a
-- document's mark to its file. A note without a matter reads exactly as
-- before.
-- stella-migration-safety: reviewed alter-policy - keeps the authored-note read policy's matter check for claim comments and extends it to matter document marks; rows without a workspace are admitted as before
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
    END AND CASE "legal_reader_annotations"."target_type" WHEN 'verification-claim' THEN public.legal_reader_annotation_claim_visible("legal_reader_annotations"."verification_claim_id", "legal_reader_annotations"."verification_run_id", "legal_reader_annotations"."workspace_id") WHEN 'matter-document' THEN public.legal_reader_annotation_document_visible("legal_reader_annotations"."target_id", "legal_reader_annotations"."entity_id", "legal_reader_annotations"."workspace_id") ELSE false END))
    AND (visibility = 'shared' OR user_id = (SELECT current_setting('app.user_id', true)))
  );--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - keeps the author insert check's claim hold and adds the file hold for matter document marks
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
    END AND CASE "legal_reader_annotations"."target_type" WHEN 'verification-claim' THEN public.legal_reader_annotation_claim_held("legal_reader_annotations"."verification_claim_id", "legal_reader_annotations"."verification_run_id", "legal_reader_annotations"."workspace_id") WHEN 'matter-document' THEN public.legal_reader_annotation_document_held("legal_reader_annotations"."target_id", "legal_reader_annotations"."entity_id", "legal_reader_annotations"."workspace_id") ELSE false END))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - keeps the author update policy's claim check and extends it to matter document marks
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
    END AND CASE "legal_reader_annotations"."target_type" WHEN 'verification-claim' THEN public.legal_reader_annotation_claim_visible("legal_reader_annotations"."verification_claim_id", "legal_reader_annotations"."verification_run_id", "legal_reader_annotations"."workspace_id") WHEN 'matter-document' THEN public.legal_reader_annotation_document_visible("legal_reader_annotations"."target_id", "legal_reader_annotations"."entity_id", "legal_reader_annotations"."workspace_id") ELSE false END))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - keeps the author delete policy's claim check and extends it to matter document marks
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
    END AND CASE "legal_reader_annotations"."target_type" WHEN 'verification-claim' THEN public.legal_reader_annotation_claim_visible("legal_reader_annotations"."verification_claim_id", "legal_reader_annotations"."verification_run_id", "legal_reader_annotations"."workspace_id") WHEN 'matter-document' THEN public.legal_reader_annotation_document_visible("legal_reader_annotations"."target_id", "legal_reader_annotations"."entity_id", "legal_reader_annotations"."workspace_id") ELSE false END))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

-- The document-cleanup trigger runs as the owner and removes every author's
-- marks on the documents a statement deleted, only during trigger execution.
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP POLICY IF EXISTS "document_cleanup_owner_select" ON "legal_reader_annotations";--> statement-breakpoint

CREATE POLICY "document_cleanup_owner_select" ON "legal_reader_annotations" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass) AND pg_catalog.pg_trigger_depth() > 0 AND entity_id IS NOT NULL
);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP POLICY IF EXISTS "document_cleanup_owner_delete" ON "legal_reader_annotations";--> statement-breakpoint

CREATE POLICY "document_cleanup_owner_delete" ON "legal_reader_annotations" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass) AND pg_catalog.pg_trigger_depth() > 0 AND entity_id IS NOT NULL
);--> statement-breakpoint

-- A document is deleted on its own or with its matter. Its marks go with it,
-- whoever wrote them: the document is not a foreign key here (a key to the
-- fenced entities would enrol reader notes in the entity gate graph), so one
-- statement-level trigger does what the cascade would.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; deletes only reader marks whose document the firing statement deleted, matched on matter and document through the partial index
CREATE OR REPLACE FUNCTION "legal_reader_annotations_drop_document_marks"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.legal_reader_annotations annotation
  USING removed_documents document
  WHERE annotation.workspace_id = document.workspace_id
    AND annotation.entity_id = document.id;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "legal_reader_annotations_drop_document_marks"() FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - Drops only the trigger the
-- next statement re-creates, so a retried migration re-enters the same state.
DROP TRIGGER IF EXISTS "entities_drop_reader_annotations" ON "entities";--> statement-breakpoint

CREATE TRIGGER "entities_drop_reader_annotations"
AFTER DELETE ON "entities"
REFERENCING OLD TABLE AS removed_documents
FOR EACH STATEMENT EXECUTE FUNCTION "legal_reader_annotations_drop_document_marks"();--> statement-breakpoint
