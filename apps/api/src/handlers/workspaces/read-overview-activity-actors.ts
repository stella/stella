import { Result } from "better-result";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
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

        const actorRows = await tx
          .selectDistinct({
            deletedAt: user.deletedAt,
            email: user.email,
            id: actorId,
            image: user.image,
            name: user.name,
          })
          .from(auditLogs)
          .leftJoin(
            member,
            and(
              eq(member.userId, actorId),
              eq(member.organizationId, session.activeOrganizationId),
            ),
          )
          .leftJoin(user, and(eq(user.id, actorId), eq(member.userId, user.id)))
          .where(and(...conditions))
          .orderBy(asc(actorId))
          .limit(limit + 1);
        const page = createCursorPage({
          rows: actorRows,
          limit,
          cursorForItem: ({ id }) => encodePaginationCursor([id]),
        });
        return page;
      }),
    );

    return Result.ok({
      items: result.items.map(({ deletedAt, email, id, image, name }) => ({
        deletedAt: deletedAt?.toISOString() ?? null,
        id,
        image,
        name: name || email,
      })),
      limit: result.limit,
      nextCursor: result.nextCursor,
    });
  },
);

export default readOverviewActivityActors;
