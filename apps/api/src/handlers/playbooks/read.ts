import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { playbookDefinitions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedPlaybookDefinitionId } from "@/api/lib/safe-id-boundaries";

// ── List ────────────────────────────────────────────

export const listPlaybookDefinitionsQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.playbookDefinitionsPageSizeMax,
    }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

// The cursor is the boundary row id alone; the query resolves that row's exact
// (created_at, id) in-DB so the comparison stays at the column's microsecond
// precision instead of a millisecond-truncated JS Date (rows sharing a
// millisecond cannot be skipped or duplicated).
const decodePlaybookDefinitionCursor = (
  cursor: string,
): SafeId<"playbookDefinition"> | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }
  const [rawId] = parts;
  if (!isUuidPaginationCursorPart(rawId)) {
    return null;
  }
  return brandPersistedPlaybookDefinitionId(rawId);
};

type ListPlaybookDefinitionsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  query: {
    limit?: number;
    cursor?: string;
  };
};

export const listPlaybookDefinitionsHandler = async function* ({
  safeDb,
  organizationId,
  query,
}: ListPlaybookDefinitionsProps) {
  const limit = query.limit ?? LIMITS.playbookDefinitionsPageSizeDefault;
  const conditions = [eq(playbookDefinitions.organizationId, organizationId)];

  if (query.cursor) {
    const cursor = decodePlaybookDefinitionCursor(query.cursor);
    if (!cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    // Fail fast on a stale or cross-org boundary id: the in-DB subquery below
    // resolves to NULL for a missing row, which would silently filter out every
    // row and return an empty page instead of a 400.
    const boundary = yield* Result.await(
      safeDb((tx) =>
        tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: cursor },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );
    if (!boundary) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    conditions.push(
      sql`(${playbookDefinitions.createdAt}, ${playbookDefinitions.id}) < (select b.created_at, b.id from playbook_definitions b where b.id = ${cursor} and b.organization_id = ${organizationId})`,
    );
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: playbookDefinitions.id,
          name: playbookDefinitions.name,
          description: playbookDefinitions.description,
          status: playbookDefinitions.status,
          createdAt: playbookDefinitions.createdAt,
          updatedAt: playbookDefinitions.updatedAt,
        })
        .from(playbookDefinitions)
        .where(and(...conditions))
        .orderBy(
          desc(playbookDefinitions.createdAt),
          desc(playbookDefinitions.id),
        )
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });

  return Result.ok({
    ...page,
    items: page.items.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
};

// ── Get ─────────────────────────────────────────────

type GetPlaybookDefinitionProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  playbookId: SafeId<"playbookDefinition">;
};

export const getPlaybookDefinitionHandler = async function* ({
  safeDb,
  organizationId,
  playbookId,
}: GetPlaybookDefinitionProps) {
  const playbook = yield* Result.await(
    safeDb((tx) =>
      tx.query.playbookDefinitions.findFirst({
        where: {
          id: { eq: playbookId },
          organizationId: { eq: organizationId },
        },
        columns: {
          id: true,
          name: true,
          description: true,
          scope: true,
          positions: true,
          status: true,
          approvedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ),
  );

  if (!playbook) {
    return Result.err(
      new HandlerError({ status: 404, message: "Playbook not found" }),
    );
  }

  return Result.ok({
    id: playbook.id,
    name: playbook.name,
    description: playbook.description,
    scope: playbook.scope,
    positions: playbook.positions,
    status: playbook.status,
    approvedAt: playbook.approvedAt ? playbook.approvedAt.toISOString() : null,
    createdAt: playbook.createdAt.toISOString(),
    updatedAt: playbook.updatedAt.toISOString(),
  });
};
