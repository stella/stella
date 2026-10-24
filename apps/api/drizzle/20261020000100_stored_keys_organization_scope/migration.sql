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
  previous_organization_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.s3_key IS DISTINCT FROM OLD.s3_key THEN
      RAISE EXCEPTION 'user_files.s3_key is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A file stays in its organization: an uploader-prefixed key must not
    -- follow its row into another organization's thread.
    IF NEW.thread_id IS DISTINCT FROM OLD.thread_id THEN
      SELECT organization_id INTO previous_organization_id
      FROM public.chat_threads
      WHERE id = OLD.thread_id;
      IF previous_organization_id IS DISTINCT FROM (
        SELECT organization_id FROM public.chat_threads WHERE id = NEW.thread_id
      ) THEN
        RAISE EXCEPTION 'user_files cannot move to another organization'
          USING ERRCODE = 'check_violation';
      END IF;
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
