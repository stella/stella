import { Result } from "better-result";
import { and, count, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { entities } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { flowOwnedEntityVisibilitySql } from "@/api/lib/flows/visibility";

const config = {
  description:
    "Count all documents, folders, and tasks in a matter. The companion " +
    "total for entities.summaries.list, whose pages carry no count of their " +
    "own.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "list_documents" },
  access: "read",
  query: t.Object({}),
} satisfies WorkspaceHandlerConfig;

/** Total entity count for the workspace; companion to `entities.summaries.list`. */
const readEntitySummariesCount = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, user }) {
    const counts = yield* await safeDb((tx) =>
      tx
        .select({ total: count() })
        .from(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            flowOwnedEntityVisibilitySql({
              organizationId: session.activeOrganizationId,
              userId: user.id,
              entityId: sql`${entities.id}`,
              workspaceId: sql`${entities.workspaceId}`,
            }),
          ),
        ),
    );

    return Result.ok({ totalCount: counts.at(0)?.total ?? 0 });
  },
);

export default readEntitySummariesCount;
