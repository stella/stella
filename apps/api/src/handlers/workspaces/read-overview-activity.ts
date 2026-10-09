import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

import {
  matterActivityFilterQueryProperties,
  toMatterActivityFilters,
} from "./matter-activity-query";
import { readOverviewActivityPage } from "./read-overview-activity.query";

const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
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
} satisfies WorkspaceHandlerConfig;

const readOverviewActivity = createSafeHandler(
  config,
  async function* ({ query, safeDb, session, workspaceId, user }) {
    const page = yield* Result.await(
      readOverviewActivityPage({
        cursor: query.cursor ?? null,
        filters: toMatterActivityFilters(query),
        limit: query.limit ?? LIMITS.matterActivityPageSizeDefault,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        safeDb,
        workspaceId,
      }),
    );
    return Result.ok(page);
  },
);

export default readOverviewActivity;
