import type { RequiredMigrationIndex } from "@/api/lib/db/migration-history";

/**
 * The trigram indexes the accent-insensitive find reads, built online
 * (`ONLINE_MIGRATION_INDEXES`) over the `search_fold` function of migration
 * 20261026210000_search_fold. Each expression is the one `findTermMatches`
 * spells, so the planner can match a find clause to it.
 */

/**
 * Cells. Keeps `fields_find_text_trgm_idx`'s partial predicate, which
 * `fields-find-text-index.test.ts` binds to `FINDABLE_FIELD_TYPES`.
 */
export const FIELDS_FIND_TEXT_FOLD_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "fields_find_text_fold_trgm_idx" ON public."fields" USING gin (search_fold(field_find_text("content")) gin_trgm_ops) WHERE "content"->>'type' IN ('file', 'text', 'single-select', 'multi-select', 'person')`,
  definitionBody:
    "ON public.fields USING gin (search_fold(field_find_text(content)) gin_trgm_ops) WHERE ((content ->> 'type'::text) = ANY (ARRAY['file'::text, 'text'::text, 'single-select'::text, 'multi-select'::text, 'person'::text]))",
  isUnique: false,
  name: "fields_find_text_fold_trgm_idx",
  tableName: "fields",
} as const satisfies RequiredMigrationIndex & { createSql: string };

/** Row names, for a find that searches no column. */
export const ENTITIES_NAME_FOLD_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "entities_name_fold_trgm_idx" ON public."entities" USING gin (search_fold("name") gin_trgm_ops)`,
  definitionBody:
    "ON public.entities USING gin (search_fold(name) gin_trgm_ops)",
  isUnique: false,
  name: "entities_name_fold_trgm_idx",
  tableName: "entities",
} as const satisfies RequiredMigrationIndex & { createSql: string };
