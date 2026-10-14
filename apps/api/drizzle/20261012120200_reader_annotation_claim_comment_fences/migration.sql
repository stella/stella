-- requires: 20261012120100_reader_annotation_verification_claims
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A claim's comment belongs to the document verification feature: both claim
-- checks admit a claim only when the caller's transaction carries that
-- feature, on top of the claim's own policies (matter access and the lists
-- feature). Notes on public-law documents never call these checks.
CREATE OR REPLACE FUNCTION public.legal_reader_annotation_claim_visible(uuid, uuid, uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(nullif(pg_catalog.current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'list-verification'
    AND EXISTS (
      SELECT 1 FROM public.legal_list_claims claim
      WHERE claim.id = $1 AND claim.run_id = $2 AND claim.workspace_id = $3
    )
$$;--> statement-breakpoint

-- The insert's check keeps holding the claim FOR KEY SHARE until the insert's
-- transaction ends, under the same feature requirement.
CREATE OR REPLACE FUNCTION public.legal_reader_annotation_claim_held(uuid, uuid, uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(nullif(pg_catalog.current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'list-verification'
    AND EXISTS (
      SELECT 1 FROM public.legal_list_claims claim
      WHERE claim.id = $1 AND claim.run_id = $2 AND claim.workspace_id = $3
      FOR KEY SHARE
    )
$$;--> statement-breakpoint

-- The claim-cleanup trigger names the claims its statement deleted in a
-- transaction-local setting for the length of its own delete, then restores
-- the setting; the owner cleanup policies admit only comments on those claims.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute stays revoked; deletes only comments on the claims the firing statement deleted and restores the setting it scopes the owner policies with
CREATE OR REPLACE FUNCTION "legal_reader_annotations_drop_claim_comments"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  enclosing_claim_ids text := pg_catalog.current_setting('app.reader_claim_cleanup_ids', true);
BEGIN
  PERFORM pg_catalog.set_config(
    'app.reader_claim_cleanup_ids',
    coalesce((SELECT pg_catalog.array_agg(claim.id)::text FROM removed_claims claim), '{}'),
    true
  );
  DELETE FROM public.legal_reader_annotations annotation
  USING removed_claims claim
  WHERE annotation.workspace_id = claim.workspace_id
    AND annotation.verification_claim_id = claim.id;
  PERFORM pg_catalog.set_config('app.reader_claim_cleanup_ids', coalesce(enclosing_claim_ids, ''), true);
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "legal_reader_annotations_drop_claim_comments"() FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - narrows the owner cleanup read to comments on the claims the running cleanup deletes
ALTER POLICY "claim_cleanup_owner_select" ON "legal_reader_annotations"
  USING (
    current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass)
    AND verification_claim_id = ANY(coalesce(nullif((SELECT pg_catalog.current_setting('app.reader_claim_cleanup_ids', true)), '')::uuid[], '{}'::uuid[]))
  );--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - narrows the owner cleanup delete to comments on the claims the running cleanup deletes
ALTER POLICY "claim_cleanup_owner_delete" ON "legal_reader_annotations"
  USING (
    current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_annotations'::regclass)
    AND verification_claim_id = ANY(coalesce(nullif((SELECT pg_catalog.current_setting('app.reader_claim_cleanup_ids', true)), '')::uuid[], '{}'::uuid[]))
  );
