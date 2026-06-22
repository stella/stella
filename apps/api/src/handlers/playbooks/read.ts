import { Result } from "better-result";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { playbooks } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedPlaybookId } from "@/api/lib/safe-id-boundaries";

const readPlaybooksQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

type PlaybookCursor = {
  createdAt: Date;
  id: SafeId<"playbook">;
};

const playbookCreatedAtCursor = sql<Date>`date_trunc('milliseconds', ${playbooks.createdAt})`;

const decodePlaybookCursor = (cursor: string): PlaybookCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const createdAt = parts?.at(0);
  const id = parts?.at(1);

  const createdAtDate = parseDateTimePaginationCursorPart(createdAt);

  if (!createdAtDate || !isUuidPaginationCursorPart(id)) {
    return null;
  }

  return { createdAt: createdAtDate, id: brandPersistedPlaybookId(id) };
};

const readPlaybooks = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: readPlaybooksQuerySchema,
  },
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? 50;
    const conditions = [eq(playbooks.workspaceId, workspaceId)];

    if (query.cursor) {
      const cursor = decodePlaybookCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = or(
        gt(playbookCreatedAtCursor, cursor.createdAt),
        and(
          eq(playbookCreatedAtCursor, cursor.createdAt),
          gt(playbooks.id, cursor.id),
        ),
      );

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: playbooks.id,
            name: playbooks.name,
            typePropertyId: playbooks.typePropertyId,
            typeValue: playbooks.typeValue,
            bundle: playbooks.bundle,
            createdAt: playbooks.createdAt,
            createdAtCursor: playbookCreatedAtCursor.as("created_at_cursor"),
            updatedAt: playbooks.updatedAt,
          })
          .from(playbooks)
          .where(and(...conditions))
          .orderBy(asc(playbookCreatedAtCursor), asc(playbooks.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.createdAtCursor.toISOString(), item.id]),
    });

    return Result.ok({
      ...page,
      items: page.items.map((row) => ({
        id: row.id,
        name: row.name,
        typePropertyId: row.typePropertyId,
        typeValue: row.typeValue,
        bundle: row.bundle,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  },
);

export default readPlaybooks;
