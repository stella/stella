import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, ne } from "drizzle-orm";
import { t } from "elysia";

import { aiMemories } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor, tSafeId } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { Page } from "@/api/lib/pagination";
import { brandPersistedAiMemoryId } from "@/api/lib/safe-id-boundaries";

const DEFAULT_LIMIT = 50;

const config = {
  // Memory is an AI-assistant capability; gate reads on chat access.
  // Row visibility (firm / own / accessible matters) is enforced by RLS,
  // so firm memory still reads org-wide for any chat-capable member.
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  query: t.Object({
    scope: t.Optional(
      t.Union([
        t.Literal("organization"),
        t.Literal("user"),
        t.Literal("workspace"),
      ]),
    ),
    status: t.Optional(
      t.Union([
        t.Literal("suggested"),
        t.Literal("active"),
        t.Literal("stale"),
        t.Literal("archived"),
      ]),
    ),
    workspaceId: t.Optional(tSafeId("workspace")),
    cursor: t.Optional(tPaginationCursor()),
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

const memoryCursor = createTimestampIdCursorCodec({
  column: aiMemories.createdAt,
  brandId: brandPersistedAiMemoryId,
});

const listMemories = createSafeRootHandler(
  config,
  async function* ({
    getAccessibleWorkspaces,
    query: {
      cursor: encodedCursor,
      limit: requestedLimit,
      scope,
      status,
      workspaceId: requestedWorkspaceId,
    },
    safeDb,
    session,
  }) {
    const accessibleWorkspaces = yield* Result.await(
      Result.tryPromise(async () => await getAccessibleWorkspaces()),
    );
    const readableWorkspaceIds = accessibleWorkspaces
      .filter(({ status: workspaceStatus }) => workspaceStatus !== "deleting")
      .map(({ id }) => id);
    const limit = requestedLimit ?? DEFAULT_LIMIT;
    const workspaceId = requestedWorkspaceId
      ? readableWorkspaceIds.find(
          (readableWorkspaceId) => readableWorkspaceId === requestedWorkspaceId,
        )
      : undefined;
    if (requestedWorkspaceId && !workspaceId) {
      return Result.err(
        new HandlerError({ status: 404, message: "Workspace not found" }),
      );
    }

    const cursor = encodedCursor ? memoryCursor.decode(encodedCursor) : null;
    if (encodedCursor && !cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    // RLS already restricts rows to what this session may see (firm +
    // own user memory + accessible matters, gated by source data scope).
    // These filters only narrow the visible set further.
    const conditions: SQL[] = [
      eq(aiMemories.organizationId, session.activeOrganizationId),
      status
        ? eq(aiMemories.status, status)
        : ne(aiMemories.status, "archived"),
    ];
    if (scope) {
      conditions.push(eq(aiMemories.scope, scope));
    }
    if (workspaceId) {
      conditions.push(eq(aiMemories.workspaceId, workspaceId));
    }
    if (cursor) {
      const keysetCondition = memoryCursor.keysetAfter({
        cursor,
        idColumn: aiMemories.id,
        direction: "descending",
      });
      if (keysetCondition) {
        conditions.push(keysetCondition);
      }
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
            createdAtCursor: memoryCursor.cursorValue.as("created_at_cursor"),
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
        ? memoryCursor.encode(lastItem.createdAtCursor, lastItem.id)
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
