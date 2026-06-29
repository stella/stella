-- Re-index the tenant search tsvectors through arabic_normalize so the
-- stored tokens match the normalized query side. Mirrors the write-side
-- expressions in lib/search/index-entity.ts and index-global.ts. Guarded
-- by to_regclass so it is a no-op on databases that predate these tables.
-- The IS DISTINCT FROM guard only rewrites rows whose tsv actually changes
-- (the Arabic-affected rows), keeping WAL and lock churn proportional to
-- the Arabic content rather than the whole table.
DO $$
BEGIN
  IF to_regclass('public.search_documents') IS NOT NULL THEN
    UPDATE "search_documents"
    SET "tsv" = to_tsvector(
      COALESCE("language", 'simple')::regconfig,
      unaccent(arabic_normalize(
        COALESCE("title", '') || ' ' || COALESCE("searchable_text", '')
      ))
    )
    WHERE "tsv" IS DISTINCT FROM to_tsvector(
      COALESCE("language", 'simple')::regconfig,
      unaccent(arabic_normalize(
        COALESCE("title", '') || ' ' || COALESCE("searchable_text", '')
      ))
    );
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.contact_search_documents') IS NOT NULL THEN
    UPDATE "contact_search_documents"
    SET "tsv" = to_tsvector(
      'simple',
      unaccent(arabic_normalize(
        COALESCE("title", '') || ' ' || COALESCE("searchable_text", '')
      ))
    )
    WHERE "tsv" IS DISTINCT FROM to_tsvector(
      'simple',
      unaccent(arabic_normalize(
        COALESCE("title", '') || ' ' || COALESCE("searchable_text", '')
      ))
    );
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.workspace_search_documents') IS NOT NULL THEN
    UPDATE "workspace_search_documents"
    SET "tsv" = to_tsvector(
      'simple',
      unaccent(arabic_normalize(
        COALESCE("title", '') || ' ' || COALESCE("searchable_text", '')
      ))
    )
    WHERE "tsv" IS DISTINCT FROM to_tsvector(
      'simple',
      unaccent(arabic_normalize(
        COALESCE("title", '') || ' ' || COALESCE("searchable_text", '')
      ))
    );
  END IF;
END $$;
