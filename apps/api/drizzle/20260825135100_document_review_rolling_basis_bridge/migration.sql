SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Rolling-deploy bridge: migrations run before every old API task has left
-- service. An old task can therefore insert the v1 JSON shape after the
-- backfills above. Normalize those inserts at the storage boundary while new
-- producers use the v2 queue; remove this trigger together with the legacy
-- queue worker once no supported release can publish v1 jobs.
CREATE FUNCTION "document_review_runs_normalize_v1_basis"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_workspace_name text;
BEGIN
  IF NEW."basis" ->> 'type' NOT IN ('references', 'combined') THEN
    RETURN NEW;
  END IF;

  SELECT "name"
  INTO target_workspace_name
  FROM "workspaces"
  WHERE "id" = NEW."workspace_id";

  IF jsonb_typeof(NEW."basis" -> 'references') = 'array' THEN
    NEW."basis" = jsonb_set(
      NEW."basis",
      '{references}',
      COALESCE(
        (
          SELECT jsonb_agg(
            ref || jsonb_build_object(
              'workspaceId', COALESCE(
                ref -> 'workspaceId',
                to_jsonb(NEW."workspace_id")
              ),
              'workspaceName', COALESCE(
                ref -> 'workspaceName',
                to_jsonb(target_workspace_name)
              )
            ) ORDER BY ordinality
          )
          FROM jsonb_array_elements(NEW."basis" -> 'references')
            WITH ORDINALITY AS refs(ref, ordinality)
        ),
        '[]'::jsonb
      ),
      true
    );
  END IF;

  IF NOT (NEW."basis" ? 'perspective') THEN
    NEW."basis" = NEW."basis" ||
      '{"perspective":{"type":"neutral"}}'::jsonb;
  ELSIF jsonb_typeof(NEW."basis" -> 'perspective') = 'string' THEN
    NEW."basis" = NEW."basis" || jsonb_build_object(
      'perspective',
      CASE NEW."basis" ->> 'perspective'
        WHEN 'buyer' THEN '{"type":"party","role":"Buyer","name":null}'::jsonb
        WHEN 'seller' THEN '{"type":"party","role":"Seller","name":null}'::jsonb
        ELSE '{"type":"neutral"}'::jsonb
      END
    );
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "document_review_runs_normalize_v1_basis_trigger"
BEFORE INSERT ON "document_review_runs"
FOR EACH ROW
EXECUTE FUNCTION "document_review_runs_normalize_v1_basis"();
