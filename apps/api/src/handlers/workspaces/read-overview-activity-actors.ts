import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
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
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
  query: v.object({
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.matterActivityActorPageSizeMax),
        ),
      ),
    ),
    search: v.optional(v.pipe(v.string(), v.maxLength(256))),
  }),
} satisfies WorkspaceHandlerConfig;

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

    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.matterActivityActorPageSizeDefault,
    );
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
