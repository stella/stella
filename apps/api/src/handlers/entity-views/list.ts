import { Result } from "better-result";
import { asc } from "drizzle-orm";

import { entityViews } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

import { response, viewOwner } from "./shared";

const config = {
  description:
    "List the current user's saved cross-matter views in tab order. The complete list is bounded by the per-user creation limit.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "workspace_schema" },
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(entityViews)
          .where(
            viewOwner({
              organizationId: session.activeOrganizationId,
              userId: user.id,
            }),
          )
          .orderBy(asc(entityViews.position), asc(entityViews.id))
          .limit(LIMITS.viewsCount),
      ),
    );
    return Result.ok({ items: rows.map(response) });
  },
);
