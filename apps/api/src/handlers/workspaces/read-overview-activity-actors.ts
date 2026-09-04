import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";

import {
  decodeActorCursor,
  encodeActorCursor,
} from "./read-overview-activity-actors.logic";
import { readOverviewActivityActorRows } from "./read-overview-activity.query";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: t.Object({
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.matterActivityActorPageSizeMax,
      }),
    ),
    search: t.Optional(t.String({ maxLength: 256 })),
  }),
} satisfies HandlerConfig;

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
    const actorRows = yield* Result.await(
      readOverviewActivityActorRows({
        afterActorId,
        limit,
        organizationId: session.activeOrganizationId,
        safeDb,
        search,
        workspaceId,
      }),
    );
    const result = createCursorPage({
      rows: actorRows,
      limit,
      cursorForItem: ({ id }) => encodeActorCursor(search, id),
    });

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
