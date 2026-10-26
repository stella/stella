SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Text as a reader types it into a find: lower-case, accents folded, so
-- `dvorak` matches `Dvořák`. `unaccent()` is only STABLE, so it cannot back an
-- index directly; this wrapper pins the dictionary and declares the result
-- immutable, which it is for a fixed dictionary. The same body as
-- `legislation_title_fold`, under a name that belongs to no one slice: the
-- matter-table find folds cell text and entity names through it, and the
-- browser's `foldLikePostgresSearch` (@stll/text-normalize) reproduces it
-- code point for code point so highlights mark what this matched.
--
-- The trigram indexes over it (`fields_find_text_fold_trgm_idx`,
-- `entities_name_fold_trgm_idx`) are built online after deploy, from
-- ONLINE_MIGRATION_INDEXES. `fields_find_text_trgm_idx` stays until the
-- folded find has shipped and production plans read the new index; a later
-- migration drops it then, since no query reads `field_find_text` unfolded.
CREATE OR REPLACE FUNCTION search_fold(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT lower(public.unaccent('public.unaccent'::regdictionary, $1))
$$;
