import { Result } from "better-result";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { t } from "elysia";

// eslint-disable-next-line security-guards/no-unscoped-user-query -- IDs come only from audit rows scoped to the authorized organization and workspace; a membership join would remove departed historical performers.
import { user } from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: t.Object({
    cursor: t.Optional(t.String({ maxLength: 512 })),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.matterActivityActorPageSizeMax,
      }),
    ),
  }),
} satisfies HandlerConfig;

const historicalActorId = () =>
  sql<string>`coalesce(${auditLogs.performerId}, ${auditLogs.userId})`;

const decodeActorCursor = (cursor: string): string | null => {
  const parts = decodePaginationCursor(cursor);
  const actorId = parts?.at(0);
  return parts?.length === 1 && typeof actorId === "string" ? actorId : null;
};

const readOverviewActivityActors = createSafeHandler(
  config,
  async function* ({ query, safeDb, session, workspaceId }) {
    const afterActorId = query.cursor ? decodeActorCursor(query.cursor) : null;
    if (query.cursor !== undefined && afterActorId === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const limit = query.limit ?? LIMITS.matterActivityActorPageSizeDefault;
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const actorId = historicalActorId();
        const conditions = [
          eq(auditLogs.organizationId, session.activeOrganizationId),
          eq(auditLogs.workspaceId, workspaceId),
          eq(auditLogs.performerType, "user"),
        ];
        if (afterActorId !== null) {
          conditions.push(gt(actorId, afterActorId));
        }

        const actorIdRows = await tx
          .selectDistinct({ id: actorId })
          .from(auditLogs)
          .where(and(...conditions))
          .orderBy(asc(actorId))
          .limit(limit + 1);
        const page = createCursorPage({
          rows: actorIdRows,
          limit,
          cursorForItem: ({ id }) => encodePaginationCursor([id]),
        });
        const actors =
          page.items.length === 0
            ? []
            : await tx
                .select({
                  deletedAt: user.deletedAt,
                  email: user.email,
                  id: user.id,
                  image: user.image,
                  name: user.name,
                })
                .from(user)
                .where(
                  inArray(
                    user.id,
                    page.items.map(({ id }) => id),
                  ),
                );

        return { actors, page };
      }),
    );

    const actorMap = new Map(result.actors.map((actor) => [actor.id, actor]));
    return Result.ok({
      items: result.page.items.map(({ id }) => {
        const actor = actorMap.get(id);
        return {
          deletedAt: actor?.deletedAt?.toISOString() ?? null,
          id,
          image: actor?.image ?? null,
          name: actor?.name || actor?.email || null,
        };
      }),
      limit: result.page.limit,
      nextCursor: result.page.nextCursor,
    });
  },
);

export default readOverviewActivityActors;
