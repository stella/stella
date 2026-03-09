import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { status, t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { clauses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

// ── Cursor helpers ───────────────────────────────────

const CURSOR_SEP = "|";

const encodeCursor = (date: Date, id: string): string =>
  `${date.toISOString()}${CURSOR_SEP}${id}`;

const decodeCursor = (cursor: string): { date: Date; id: string } | null => {
  const idx = cursor.indexOf(CURSOR_SEP);
  if (idx === -1) {
    return null;
  }
  const date = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(date.getTime()) || !id) {
    return null;
  }
  return { date, id };
};

// ── List ────────────────────────────────────────────

export const listClausesQuerySchema = t.Object({
  categoryId: t.Optional(tNanoid),
  q: t.Optional(t.String({ minLength: 1 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
  cursor: t.Optional(t.String()),
});

type ListClausesProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  query: {
    categoryId?: string;
    q?: string;
    limit?: number;
    cursor?: string;
  };
};

export const listClausesHandler = async ({
  scopedDb,
  organizationId,
  query,
}: ListClausesProps) => {
  const limit = query.limit ?? 50;

  const conditions = [eq(clauses.organizationId, organizationId)];

  if (query.categoryId) {
    conditions.push(eq(clauses.categoryId, query.categoryId));
  }

  const isSearching = !!query.q;

  if (query.q) {
    conditions.push(
      sql`${clauses.searchVector} @@ websearch_to_tsquery('english', ${query.q})`,
    );
  }

  // Cursor pagination only applies to date-ordered
  // browsing; rank-ordered search ignores the cursor.
  if (query.cursor && !isSearching) {
    const parsed = decodeCursor(query.cursor);
    if (parsed) {
      // Compound cursor: (createdAt < cursorDate) OR
      // (createdAt = cursorDate AND id < cursorId)
      const cursorCondition = or(
        lt(clauses.createdAt, parsed.date),
        and(
          eq(clauses.createdAt, parsed.date),
          sql`${clauses.id} < ${parsed.id}`,
        ),
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }
  }

  const rankExpr = isSearching
    ? sql<number>`ts_rank(${clauses.searchVector}, websearch_to_tsquery('english', ${query.q}))`
    : undefined;

  const selectColumns = {
    id: clauses.id,
    title: clauses.title,
    categoryId: clauses.categoryId,
    language: clauses.language,
    description: clauses.description,
    currentVersion: clauses.currentVersion,
    createdAt: clauses.createdAt,
    updatedAt: clauses.updatedAt,
  };

  const rows = await scopedDb((tx) =>
    tx
      .select(rankExpr ? { ...selectColumns, rank: rankExpr } : selectColumns)
      .from(clauses)
      .where(and(...conditions))
      .orderBy(
        ...(isSearching
          ? [
              sql`ts_rank(${clauses.searchVector}, websearch_to_tsquery('english', ${query.q})) DESC`,
            ]
          : [desc(clauses.createdAt), desc(clauses.id)]),
      )
      .limit(limit + 1),
  );

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = items.at(-1);
  // Cursor pagination is incompatible with rank-based
  // ordering; disable it when searching.
  const nextCursor =
    hasMore && lastItem && !isSearching
      ? encodeCursor(lastItem.createdAt, lastItem.id)
      : null;

  return {
    clauses: items,
    nextCursor,
  };
};

// ── Get ─────────────────────────────────────────────

type GetClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
};

export const getClauseHandler = async ({
  scopedDb,
  organizationId,
  clauseId,
}: GetClauseProps) => {
  const clause = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: clauseId,
        organizationId: { eq: organizationId },
      },
      columns: {
        id: true,
        title: true,
        categoryId: true,
        description: true,
        usageNotes: true,
        language: true,
        body: true,
        metadata: true,
        currentVersion: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
      with: {
        variants: {
          columns: {
            id: true,
            label: true,
            body: true,
            sortOrder: true,
            createdAt: true,
          },
          orderBy: { sortOrder: "asc" },
          limit: LIMITS.clauseVariantsPerClause,
        },
        versions: {
          columns: {
            id: true,
            version: true,
            createdAt: true,
          },
          orderBy: { version: "desc" },
          limit: LIMITS.clauseVersionsPerClause,
        },
      },
    }),
  );

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  return clause;
};

// ── Get version body ─────────────────────────────────

type GetClauseVersionProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
  versionId: string;
};

export const getClauseVersionHandler = async ({
  scopedDb,
  organizationId,
  clauseId,
  versionId,
}: GetClauseVersionProps) => {
  // Verify clause belongs to this org (tenant isolation)
  const clause = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: clauseId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const version = await scopedDb((tx) =>
    tx.query.clauseVersions.findFirst({
      where: { id: versionId, clauseId },
      columns: {
        id: true,
        version: true,
        body: true,
        createdAt: true,
      },
    }),
  );

  if (!version) {
    return status(404, { message: "Version not found" });
  }

  return version;
};
