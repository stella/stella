import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

export type PreviewPassageTable =
  | "case-law"
  | "chat"
  | "contact"
  | "document"
  | "matter";

type PreviewPassageJoinOptions = {
  generation: SQL;
  locatorTsQuery: SQL | null;
  parentFilter: SQL;
  table: PreviewPassageTable;
  tenantFilter?: SQL | undefined;
};

export const previewPassageJoin = ({
  generation,
  locatorTsQuery,
  parentFilter,
  table,
  tenantFilter = sql.empty(),
}: PreviewPassageJoinOptions): SQL => {
  if (!locatorTsQuery) {
    return sql.empty();
  }
  switch (table) {
    case "case-law":
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM case_law_search_document_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.tsv @@ ${locatorTsQuery}
            ORDER BY passage.ordinal
            LIMIT 1
          )
          UNION ALL
          (
            SELECT passage.content, passage.ordinal, 1 AS priority
            FROM case_law_search_document_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.ordinal = 0
            LIMIT 1
          )
          ORDER BY priority, ordinal
          LIMIT 1
        ) preview_passage ON true
      `;
    case "chat":
      // oxlint-disable-next-line require-search-scope/require-search-scope -- centralized helper emits only correlated LATERAL passage reads; the guarded call site scopes the owning chat projection
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM chat_thread_search_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.tsv @@ ${locatorTsQuery}
            ORDER BY passage.ordinal
            LIMIT 1
          )
          UNION ALL
          (
            SELECT passage.content, passage.ordinal, 1 AS priority
            FROM chat_thread_search_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.ordinal = 0
            LIMIT 1
          )
          ORDER BY priority, ordinal
          LIMIT 1
        ) preview_passage ON true
      `;
    case "contact":
      // oxlint-disable-next-line require-search-scope/require-search-scope -- centralized helper emits only correlated LATERAL passage reads; the guarded call site scopes the owning contact projection
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM contact_search_document_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.tsv @@ ${locatorTsQuery}
            ORDER BY passage.ordinal
            LIMIT 1
          )
          UNION ALL
          (
            SELECT passage.content, passage.ordinal, 1 AS priority
            FROM contact_search_document_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.ordinal = 0
            LIMIT 1
          )
          ORDER BY priority, ordinal
          LIMIT 1
        ) preview_passage ON true
      `;
    case "document":
      // oxlint-disable-next-line require-search-scope/require-search-scope -- centralized helper emits only correlated LATERAL passage reads; the guarded call site scopes the owning document projection
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM search_document_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.tsv @@ ${locatorTsQuery}
            ORDER BY passage.ordinal
            LIMIT 1
          )
          UNION ALL
          (
            SELECT passage.content, passage.ordinal, 1 AS priority
            FROM search_document_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.ordinal = 0
            LIMIT 1
          )
          ORDER BY priority, ordinal
          LIMIT 1
        ) preview_passage ON true
      `;
    case "matter":
      // oxlint-disable-next-line require-search-scope/require-search-scope -- centralized helper emits only correlated LATERAL passage reads; the guarded call site scopes the owning workspace projection
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM workspace_search_document_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.tsv @@ ${locatorTsQuery}
            ORDER BY passage.ordinal
            LIMIT 1
          )
          UNION ALL
          (
            SELECT passage.content, passage.ordinal, 1 AS priority
            FROM workspace_search_document_preview_passages passage
            WHERE ${parentFilter}
              AND passage.generation = ${generation}
              ${tenantFilter}
              AND passage.ordinal = 0
            LIMIT 1
          )
          ORDER BY priority, ordinal
          LIMIT 1
        ) preview_passage ON true
      `;
    default: {
      const exhaustive: never = table;
      return exhaustive;
    }
  }
};
