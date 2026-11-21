-- requires: 20261020000100_stored_keys_organization_scope
SET lock_timeout = '5s';
SET statement_timeout = '5min';

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
