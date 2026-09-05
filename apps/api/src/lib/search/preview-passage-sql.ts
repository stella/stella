import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  chatPreviewPassageScopeSql,
  contactPreviewPassageScopeSql,
  documentPreviewPassageScopeSql,
  workspacePreviewPassageScopeSql,
} from "@/api/lib/search/preview-passage-scope-sql";

export type PreviewPassageTable =
  | "case-law"
  | "chat"
  | "contact"
  | "document"
  | "matter";

type CommonPreviewPassageJoinOptions = {
  generation: SQL;
  locatorTsQuery: SQL | null;
  tenantFilter?: SQL | undefined;
};

type PreviewPassageJoinOptions = CommonPreviewPassageJoinOptions &
  (
    | {
        parentFilter: SQL;
        table: "case-law";
      }
    | {
        parentFilter?: never;
        table: Exclude<PreviewPassageTable, "case-law">;
      }
  );

export const previewPassageJoin = (options: PreviewPassageJoinOptions): SQL => {
  const {
    generation,
    locatorTsQuery,
    table,
    tenantFilter = sql.empty(),
  } = options;
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
            WHERE ${options.parentFilter}
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
            WHERE ${options.parentFilter}
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
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM chat_thread_search_preview_passages passage
            WHERE ${chatPreviewPassageScopeSql()}
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
            WHERE ${chatPreviewPassageScopeSql()}
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
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM contact_search_document_preview_passages passage
            WHERE ${contactPreviewPassageScopeSql()}
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
            WHERE ${contactPreviewPassageScopeSql()}
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
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM search_document_preview_passages passage
            WHERE ${documentPreviewPassageScopeSql()}
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
            WHERE ${documentPreviewPassageScopeSql()}
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
      return sql`
        LEFT JOIN LATERAL (
          (
            SELECT passage.content, passage.ordinal, 0 AS priority
            FROM workspace_search_document_preview_passages passage
            WHERE ${workspacePreviewPassageScopeSql()}
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
            WHERE ${workspacePreviewPassageScopeSql()}
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
      table satisfies never;
      return panic(`Unhandled table: ${String(table)}`);
    }
  }
};
