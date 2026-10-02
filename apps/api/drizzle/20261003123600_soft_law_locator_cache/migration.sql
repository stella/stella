-- requires: 20261003123500_soft_law_corpus
SET lock_timeout = '5s';
SET statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE public.soft_law_document_locators ADD COLUMN cache_key text, ADD COLUMN cache_content_hash text;
--> statement-breakpoint
ALTER TABLE public.soft_law_document_locators ADD CONSTRAINT soft_law_locators_cache_check CHECK (cache_key IS NULL OR cache_content_hash IS NOT NULL);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaced in this migration with the same constraint plus explicit terminal exclusion reasons.
ALTER TABLE public.soft_law_ingestion_attempts DROP CONSTRAINT soft_law_attempts_tag_check;
--> statement-breakpoint
ALTER TABLE public.soft_law_ingestion_attempts ADD CONSTRAINT soft_law_attempts_tag_check CHECK ((status = 'rejected' AND tag IS NOT NULL AND tag IN ('identity_collision','ambiguous_locator','invalid_document','retry_exhausted','edpb_translation','third_party_publication')) OR (status <> 'rejected' AND tag IS NULL));
