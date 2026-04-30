CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_ts_config
    WHERE cfgname = 'stella_unaccent'
      AND cfgnamespace = 'public'::regnamespace
  ) THEN
    CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple);
  END IF;
END $$;--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION public.stella_unaccent
  ALTER MAPPING FOR
    asciiword,
    asciihword,
    hword_asciipart,
    word,
    hword,
    hword_part
  WITH unaccent, simple;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.search_documents') IS NOT NULL THEN
    UPDATE "search_documents"
    SET "tsv" = to_tsvector(
      COALESCE("language", 'simple')::regconfig,
      unaccent(COALESCE("title", '') || ' ' || COALESCE("searchable_text", ''))
    );
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.contact_search_documents') IS NOT NULL THEN
    UPDATE "contact_search_documents"
    SET "tsv" = to_tsvector(
      'simple',
      unaccent(COALESCE("title", '') || ' ' || COALESCE("searchable_text", ''))
    );
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.workspace_search_documents') IS NOT NULL THEN
    UPDATE "workspace_search_documents"
    SET "tsv" = to_tsvector(
      'simple',
      unaccent(COALESCE("title", '') || ' ' || COALESCE("searchable_text", ''))
    );
  END IF;
END $$;
