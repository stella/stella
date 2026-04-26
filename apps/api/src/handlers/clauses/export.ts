import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauses } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

import type {
  ClauseExportItem,
  ClauseExportPayload,
} from "./import-export-schema";

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
    const idList = query.ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => toSafeId<"clause">(id));
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
      }),
    ),
  );

  const categoryMap = new Map(allCategories.map((c) => [c.id, c]));

  const buildPath = (
    catId: SafeId<"clauseCategory"> | null,
  ): string[] | null => {
    if (!catId) {
      return null;
    }
    const path: string[] = [];
    let current: SafeId<"clauseCategory"> | null = catId;
    const visited = new Set<SafeId<"clauseCategory">>();
    while (current) {
      if (visited.has(current)) {
        break;
      }
      visited.add(current);
      const cat = categoryMap.get(current);
      if (!cat) {
        break;
      }
      path.unshift(cat.name);
      current = cat.parentId;
    }
    return path.length > 0 ? path : null;
  };

  const items: ClauseExportItem[] = rows.map((row) => ({
    title: row.title,
    description: row.description,
    usageNotes: row.usageNotes,
    language: row.language,
    body: row.body,
    // SAFETY: metadata is Record<string, unknown> stored as JSONB
    metadata: row.metadata,
    categoryName: row.categoryId
      ? (categoryMap.get(row.categoryId)?.name ?? null)
      : null,
    categoryPath: buildPath(row.categoryId),
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
