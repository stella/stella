import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

import {
  decodeActorCursor,
  encodeActorCursor,
} from "./read-overview-activity-actors.logic";
import { readOverviewActivityActorRows } from "./read-overview-activity-actors.query";

const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
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
} satisfies WorkspaceHandlerConfig;

const readOverviewActivityActors = createSafeHandler(
  config,
  async function* ({ query, safeDb, session, workspaceId, user }) {
    const search = query.search?.trim() ?? "";
    const afterActorId = query.cursor
      ? decodeActorCursor(query.cursor, search)
      : null;
    if (query.cursor !== undefined && afterActorId === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.matterActivityActorPageSizeDefault,
    );
    const actorRows = yield* Result.await(
      readOverviewActivityActorRows({
        afterActorId,
        limit,
        organizationId: session.activeOrganizationId,
        userId: user.id,
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
