import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { clauses, clauseVariants } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedClauseId } from "@/api/lib/safe-id-boundaries";

import { buildClauseCategoryPath } from "./category-path";
import type {
  ClauseExportItem,
  ClauseExportPayload,
  ClauseExportVariant,
} from "./import-export-schema";
import { normalizeClauseMetadata } from "./metadata";

const exportQuerySchema = t.Object({
  ids: t.Optional(t.String()),
});

type ExportProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  query: { ids?: string };
};

const exportHandler = async function* ({
  safeDb,
  organizationId,
  query,
}: ExportProps) {
  const conditions = [eq(clauses.organizationId, organizationId)];

  if (query.ids) {
    const idList = query.ids.split(",").flatMap((s) => {
      const trimmed = s.trim();
      return trimmed ? [brandPersistedClauseId(trimmed)] : [];
    });
    if (idList.length > 0) {
      conditions.push(inArray(clauses.id, idList));
    }
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: clauses.id,
          title: clauses.title,
          description: clauses.description,
          usageNotes: clauses.usageNotes,
          language: clauses.language,
          body: clauses.body,
          metadata: clauses.metadata,
          categoryId: clauses.categoryId,
        })
        .from(clauses)
        .where(and(...conditions))
        .limit(LIMITS.clauseExportLimit),
    ),
  );

  // Load categories for path building
  const allCategories = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseCategories.findMany({
        where: { organizationId: { eq: organizationId } },
        columns: { id: true, name: true, parentId: true },
        limit: LIMITS.clauseCategoriesCount,
      }),
    ),
  );

  // Author-curated variant bodies, grouped per clause in display order.
  const clauseIds = rows.map((row) => row.id);
  const variantRows =
    clauseIds.length > 0
      ? yield* Result.await(
          safeDb((tx) =>
            tx
              .select({
                clauseId: clauseVariants.clauseId,
                label: clauseVariants.label,
                body: clauseVariants.body,
                sortOrder: clauseVariants.sortOrder,
              })
              .from(clauseVariants)
              .where(
                and(
                  eq(clauseVariants.organizationId, organizationId),
                  inArray(clauseVariants.clauseId, clauseIds),
                ),
              ),
          ),
        )
      : [];

  const variantsByClause = new Map<SafeId<"clause">, ClauseExportVariant[]>();
  for (const variant of variantRows.toSorted(
    (a, b) => a.sortOrder - b.sortOrder,
  )) {
    const storedVariants = variantsByClause.get(variant.clauseId);
    const list = arrayOrEmpty(storedVariants);
    list.push({ label: variant.label, body: variant.body });
    variantsByClause.set(variant.clauseId, list);
  }

  const categoryMap = new Map(allCategories.map((c) => [c.id, c]));

  const items: ClauseExportItem[] = rows.map((row) => ({
    title: row.title,
    description: row.description,
    usageNotes: row.usageNotes,
    language: row.language,
    body: row.body,
    variants: (() => {
      const storedVariants = variantsByClause.get(row.id);
      return arrayOrEmpty(storedVariants);
    })(),
    metadata: normalizeClauseMetadata(row.metadata) ?? null,
    categoryName: row.categoryId
      ? (categoryMap.get(row.categoryId)?.name ?? null)
      : null,
    categoryPath: buildClauseCategoryPath(categoryMap, row.categoryId),
  }));

  const payload: ClauseExportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    clauses: items,
  };

  return Result.ok(
    new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="clauses-export.json"',
      },
    }),
  );
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  access: "read",
  query: exportQuerySchema,
} satisfies HandlerConfig;

const exportClauses = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    return yield* exportHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      query,
    });
  },
);

export default exportClauses;
