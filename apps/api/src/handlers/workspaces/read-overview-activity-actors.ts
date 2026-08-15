import { Result } from "better-result";
import { and, asc, eq, gt, ilike, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

import { visibleActivityCondition } from "./read-overview-activity.query";

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
    search: t.Optional(t.String({ maxLength: 256 })),
  }),
} satisfies HandlerConfig;

const historicalActorId = () =>
  sql<string>`coalesce(${auditLogs.performerId}, ${auditLogs.userId})`;

const decodeActorCursor = (cursor: string, search: string): string | null => {
  const parts = decodePaginationCursor(cursor);
  const cursorSearch = parts?.at(0);
  const actorId = parts?.at(1);
  return parts?.length === 2 &&
    cursorSearch === search &&
    typeof actorId === "string"
    ? actorId
    : null;
};

const readOverviewActivityActors = createSafeHandler(
  config,
  async function* ({ query, safeDb, session, workspaceId }) {
    const search = query.search?.trim() ?? "";
    const afterActorId = query.cursor
      ? decodeActorCursor(query.cursor, search)
      : null;
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
          visibleActivityCondition(),
        ];
        if (afterActorId !== null) {
          conditions.push(gt(actorId, afterActorId));
        }
        if (search !== "") {
          const pattern = `%${escapeLike(search)}%`;
          conditions.push(
            or(ilike(user.name, pattern), ilike(user.email, pattern)) ??
              sql`false`,
          );
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
          // The actor ID comes from an organization-and-workspace-scoped audit
          // row, so attribution remains authorized after membership ends.
          .leftJoin(user, eq(user.id, actorId))
          .where(and(...conditions))
          .orderBy(asc(actorId))
          .limit(limit + 1);
        const page = createCursorPage({
          rows: actorRows,
          limit,
          cursorForItem: ({ id }) => encodePaginationCursor([search, id]),
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
