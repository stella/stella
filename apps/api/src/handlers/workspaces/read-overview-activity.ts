import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

import {
  matterActivityFilterQueryProperties,
  toMatterActivityFilters,
} from "./matter-activity-query";
import { readOverviewActivityPage } from "./read-overview-activity.query";

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
  query: v.object({
    ...matterActivityFilterQueryProperties,
    cursor: v.exactOptional(paginationCursorSchema()),
    limit: v.exactOptional(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.matterActivityPageSizeMax),
        ),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const readOverviewActivity = createSafeHandler(
  config,
  async function* ({
    query,
    safeDb,
    session,
    workspaceId,
    user,
    featureAccessSnapshot,
  }) {
    const page = yield* Result.await(
      readOverviewActivityPage({
        cursor: query.cursor ?? null,
        filters: toMatterActivityFilters(query),
        limit: query.limit ?? LIMITS.matterActivityPageSizeDefault,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        featureAccessSnapshot,
        safeDb,
        workspaceId,
      }),
    );
    return Result.ok(page);
  },
);

export default readOverviewActivity;
