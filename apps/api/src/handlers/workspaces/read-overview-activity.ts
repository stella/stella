import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

import {
  matterActivityFilterQueryProperties,
  toMatterActivityFilters,
} from "./matter-activity-query";
import { readOverviewActivityPage } from "./read-overview-activity.query";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: t.Object({
    ...matterActivityFilterQueryProperties,
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.matterActivityPageSizeMax,
      }),
    ),
  }),
} satisfies HandlerConfig;

const readOverviewActivity = createSafeHandler(
  config,
  async function* ({ query, safeDb, session, workspaceId }) {
    const page = yield* Result.await(
      readOverviewActivityPage({
        cursor: query.cursor ?? null,
        filters: toMatterActivityFilters(query),
        limit: query.limit ?? LIMITS.matterActivityPageSizeDefault,
        organizationId: session.activeOrganizationId,
        safeDb,
        workspaceId,
      }),
    );
    return Result.ok(page);
  },
);

export default readOverviewActivity;
