import { Result } from "better-result";
import { and, asc, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { clauses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isUuid, tSafeId } from "@/api/lib/custom-schema";
import {
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import type { ParsedPgTimestampCursor } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";

// ── Cursor helpers ───────────────────────────────────

const CURSOR_SEP = "|";

const clauseCreatedAtCursor = pgTimestampCursorValue(clauses.createdAt);

const encodeCursor = (date: string, id: string): string =>
  `${date}${CURSOR_SEP}${id}`;

const decodeCursor = (
  cursor: string,
): { date: ParsedPgTimestampCursor; id: string } | null => {
  const idx = cursor.indexOf(CURSOR_SEP);
  if (idx === -1) {
    return null;
  }
  const date = parsePgTimestampCursorValue(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (date === null || !isUuid(id)) {
    return null;
  }
  return { date, id };
};

// ── List ────────────────────────────────────────────

export const listClausesQuerySchema = t.Object({
  categoryId: t.Optional(tSafeId("clauseCategory")),
  q: t.Optional(t.String({ minLength: 1 })),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.clausesPageSizeMax }),
  ),
  cursor: t.Optional(t.String()),
});

type ListClausesProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  query: {
    categoryId?: SafeId<"clauseCategory">;
    q?: string;
    limit?: number;
    cursor?: string;
  };
};

/** Build a prefix `tsquery` (`term:* & term:* …`) from raw user input so
 *  search-as-you-type matches partial words: typing "gov" must hit "Governing".
 *  `websearch_to_tsquery` only matches whole stemmed words, so a partial query
 *  returns nothing until a word is complete. Split on every non-alphanumeric run
 *  (not just whitespace) so a separator like `-` or `/` yields separate prefix
 *  terms — `non-compete` → `non:* & compete:*`, matching the FTS lexemes — rather
 *  than one mashed-together token; the separators are also `tsquery` operators
 *  that would otherwise throw. */
export const toClausePrefixTsQuery = (raw: string): string =>
  raw
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
    .map((term) => `${term}:*`)
    .join(" & ");

export const listClausesHandler = async function* ({
  safeDb,
  organizationId,
  query,
}: ListClausesProps) {
  const limit = query.limit ?? LIMITS.clausesPageSizeDefault;

  const conditions = [eq(clauses.organizationId, organizationId)];

  if (query.categoryId) {
    conditions.push(eq(clauses.categoryId, query.categoryId));
  }

  // Search-as-you-type: match the title directly (substring, so a typed prefix
  // filters immediately and it works even when `search_vector` is not populated)
  // OR the full-text vector with a prefix query (content matches). Stays
  // server-side with a LIMIT, so it scales with the library.
  const tsQuery = query.q ? toClausePrefixTsQuery(query.q) : "";
  const isSearching = !!query.q;

  if (isSearching && query.q) {
    const titleMatch = ilike(clauses.title, `%${escapeLike(query.q)}%`);
    const ftsMatch =
      tsQuery.length > 0
        ? sql`${clauses.searchVector} @@ to_tsquery('english', ${tsQuery})`
        : null;
    conditions.push(
      ftsMatch ? (or(titleMatch, ftsMatch) ?? titleMatch) : titleMatch,
    );
  }

  // Cursor pagination only applies to date-ordered
  // browsing; search results ignore the cursor.
  if (query.cursor && !isSearching) {
    const parsed = decodeCursor(query.cursor);
    if (parsed === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    // Compound cursor: (createdAt < cursorDate) OR
    // (createdAt = cursorDate AND id < cursorId)
    const cursorCondition = or(
      lt(clauses.createdAt, pgTimestampCursorBoundary(parsed.date)),
      and(
        eq(clauses.createdAt, pgTimestampCursorBoundary(parsed.date)),
        sql`${clauses.id} < ${parsed.id}`,
      ),
    );
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  const selectColumns = {
    id: clauses.id,
    title: clauses.title,
    categoryId: clauses.categoryId,
    language: clauses.language,
    description: clauses.description,
    currentVersion: clauses.currentVersion,
    createdAt: clauses.createdAt,
    createdAtCursor: clauseCreatedAtCursor.as("created_at_cursor"),
    updatedAt: clauses.updatedAt,
  };

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select(selectColumns)
        .from(clauses)
        .where(and(...conditions))
        .orderBy(
          ...(isSearching
            ? [asc(clauses.title)]
            : [desc(clauses.createdAt), desc(clauses.id)]),
        )
        .limit(limit + 1),
    ),
  );

  // Cursor pagination is incompatible with search
  // ordering; disable it when searching.
  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodeCursor(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    items: page.items.map(
      ({ createdAtCursor: _createdAtCursor, ...item }) => item,
    ),
    nextCursor: isSearching ? null : page.nextCursor,
  });
};

// ── Get ─────────────────────────────────────────────

type GetClauseProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
};

export const getClauseHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
}: GetClauseProps) {
  const clause = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauses.findFirst({
        where: {
          id: { eq: clauseId },
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
    ),
  );

  if (!clause) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  return Result.ok(clause);
};

// ── Get version body ─────────────────────────────────

type GetClauseVersionProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
  versionId: SafeId<"clauseVersion">;
};

export const getClauseVersionHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  versionId,
}: GetClauseVersionProps) {
  // Verify clause belongs to this org (tenant isolation)
  const clause = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauses.findFirst({
        where: {
          id: { eq: clauseId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true },
      }),
    ),
  );

  if (!clause) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const version = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseVersions.findFirst({
        where: {
          id: { eq: versionId },
          clauseId: { eq: clauseId },
          organizationId: { eq: organizationId },
        },
        columns: {
          id: true,
          version: true,
          body: true,
          createdAt: true,
        },
      }),
    ),
  );

  if (!version) {
    return Result.err(
      new HandlerError({ status: 404, message: "Version not found" }),
    );
  }

  return Result.ok(version);
};
