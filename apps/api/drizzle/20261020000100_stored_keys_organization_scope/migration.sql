-- requires: 20261019090100_soft_law_legacy_receipt_entry_type
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.templates
  ADD CONSTRAINT templates_s3_key_organization_check
  CHECK (starts_with(s3_key, organization_id || '/')) NOT VALID;
ALTER TABLE public.template_versions
  ADD CONSTRAINT template_versions_s3_key_organization_check
  CHECK (starts_with(s3_key, organization_id || '/')) NOT VALID;
ALTER TABLE public.style_sets
  ADD CONSTRAINT style_sets_s3_key_organization_check
  CHECK (starts_with(s3_key, organization_id || '/')) NOT VALID;

CREATE FUNCTION public.user_files_enforce_organization_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  owning_organization_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.s3_key IS DISTINCT FROM OLD.s3_key THEN
      RAISE EXCEPTION 'user_files.s3_key is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT organization_id INTO owning_organization_id
  FROM public.chat_threads
  WHERE id = NEW.thread_id;

  IF owning_organization_id IS NULL OR (
    NOT starts_with(NEW.s3_key, owning_organization_id || '/')
    AND (TG_OP = 'INSERT' OR NOT starts_with(NEW.s3_key, NEW.user_id || '/'))
  ) THEN
    RAISE EXCEPTION 'user_files.s3_key must use its organization prefix'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_files_organization_key_guard
BEFORE INSERT OR UPDATE OF s3_key, thread_id ON public.user_files
FOR EACH ROW EXECUTE FUNCTION public.user_files_enforce_organization_key();

-- Precheck: report every incompatible row before validating the constraints.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.templates WHERE NOT starts_with(s3_key, organization_id || '/'))
     OR EXISTS (SELECT 1 FROM public.template_versions WHERE NOT starts_with(s3_key, organization_id || '/'))
     OR EXISTS (SELECT 1 FROM public.style_sets WHERE NOT starts_with(s3_key, organization_id || '/'))
     OR EXISTS (
       SELECT 1 FROM public.user_files uf
       LEFT JOIN public.chat_threads ct ON ct.id = uf.thread_id
       WHERE ct.organization_id IS NULL OR (
         NOT starts_with(uf.s3_key, ct.organization_id || '/')
         AND NOT starts_with(uf.s3_key, uf.user_id || '/')
       )
     ) THEN
    RAISE EXCEPTION 'stored object keys must use their organization prefix'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

ALTER TABLE public.templates VALIDATE CONSTRAINT templates_s3_key_organization_check;
ALTER TABLE public.template_versions VALIDATE CONSTRAINT template_versions_s3_key_organization_check;
ALTER TABLE public.style_sets VALIDATE CONSTRAINT style_sets_s3_key_organization_check;
