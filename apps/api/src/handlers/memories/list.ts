import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { t } from "elysia";

import { aiMemories } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isMicrosecondTimestampPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type { Page } from "@/api/lib/pagination";
import { brandPersistedAiMemoryId } from "@/api/lib/safe-id-boundaries";

const DEFAULT_LIMIT = 50;

const config = {
  // Memory is an AI-assistant capability; gate reads on chat access.
  // Row visibility (firm / own / accessible matters) is enforced by RLS,
  // so firm memory still reads org-wide for any chat-capable member.
  permissions: { chat: ["create"] },
  query: t.Object({
    scope: t.Optional(t.UnionEnum(["organization", "user", "workspace"])),
    status: t.Optional(
      t.UnionEnum(["suggested", "active", "stale", "archived"]),
    ),
    workspaceId: t.Optional(tSafeId("workspace")),
    cursor: t.Optional(t.String({ maxLength: 512 })),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  }),
} satisfies HandlerConfig;

type MemoryListItem = {
  id: string;
  scope: "organization" | "user" | "workspace";
  kind: "preference" | "instruction" | "fact" | "decision" | "relationship";
  content: string;
  language: string | null;
  status: "suggested" | "active" | "stale" | "archived";
  pinned: boolean;
  source: "user" | "tool" | "extracted";
  workspaceId: string | null;
  sourceDataWorkspaceIds: string[];
  createdAt: string;
  updatedAt: string;
};

const decodeCursor = (
  cursor: string,
): { createdAt: string; id: SafeId<"aiMemory"> } | null => {
  const parts = decodePaginationCursor(cursor);
  const createdAt = parts?.at(0);
  const id = parts?.at(1);
  if (
    !isMicrosecondTimestampPaginationCursorPart(createdAt) ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }
  // Keep the microsecond timestamp verbatim for the keyset
  // `::timestamp` comparison; a Date round-trip would truncate it.
  return { createdAt, id: brandPersistedAiMemoryId(id) };
};

const listMemories = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const limit = query.limit ?? DEFAULT_LIMIT;

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    // RLS already restricts rows to what this session may see (firm +
    // own user memory + accessible matters, gated by source data scope).
    // These filters only narrow the visible set further.
    const conditions: SQL[] = [
      eq(aiMemories.organizationId, session.activeOrganizationId),
      query.status
        ? eq(aiMemories.status, query.status)
        : ne(aiMemories.status, "archived"),
    ];
    if (query.scope) {
      conditions.push(eq(aiMemories.scope, query.scope));
    }
    if (query.workspaceId) {
      conditions.push(eq(aiMemories.workspaceId, query.workspaceId));
    }
    if (cursor) {
      conditions.push(
        sql`(${aiMemories.createdAt}, ${aiMemories.id}) < (${cursor.createdAt}::timestamp, ${cursor.id}::uuid)`,
      );
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: aiMemories.id,
            scope: aiMemories.scope,
            kind: aiMemories.kind,
            content: aiMemories.content,
            language: aiMemories.language,
            status: aiMemories.status,
            pinned: aiMemories.pinned,
            source: aiMemories.source,
            workspaceId: aiMemories.workspaceId,
            sourceDataWorkspaceIds: aiMemories.sourceDataWorkspaceIds,
            createdAt: aiMemories.createdAt,
            createdAtCursor: sql<string>`to_char(
              ${aiMemories.createdAt},
              'YYYY-MM-DD"T"HH24:MI:SS.US'
            )`,
            updatedAt: aiMemories.updatedAt,
          })
          .from(aiMemories)
          .where(and(...conditions))
          .orderBy(desc(aiMemories.createdAt), desc(aiMemories.id))
          .limit(limit + 1),
      ),
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = pageRows.at(-1);
    const nextCursor =
      hasMore && lastItem
        ? encodePaginationCursor([lastItem.createdAtCursor, lastItem.id])
        : null;

    const items: MemoryListItem[] = pageRows.map((row) => ({
      id: row.id,
      scope: row.scope,
      kind: row.kind,
      content: row.content,
      language: row.language,
      status: row.status,
      pinned: row.pinned,
      source: row.source,
      workspaceId: row.workspaceId,
      sourceDataWorkspaceIds: row.sourceDataWorkspaceIds,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    return Result.ok({
      items,
      nextCursor,
      limit,
    } satisfies Page<MemoryListItem>);
  },
);

export default listMemories;
