-- Ordered BCP-47 tags for the template's document text. Bilingual legal
-- templates (e.g. a Polish|English two-column contract) list every language,
-- primary first, so fill paths and AI adaptation can match the document.
-- Constant default keeps the ADD COLUMN metadata-only (rollout-safe).
ALTER TABLE "templates" ADD COLUMN "languages" text[] DEFAULT '{}' NOT NULL;
