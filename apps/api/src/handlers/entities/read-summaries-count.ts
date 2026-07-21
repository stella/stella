import { Result } from "better-result";
import { count, eq } from "drizzle-orm";
import { t } from "elysia";

import { entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_documents" },
  access: "read",
  query: t.Object({}),
} satisfies HandlerConfig;

/** Total entity count for the workspace; companion to `entities.read-summaries`. */
const readEntitySummariesCount = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    const counts = yield* await safeDb((tx) =>
      tx
        .select({ total: count() })
        .from(entities)
        .where(eq(entities.workspaceId, workspaceId)),
    );

    return Result.ok({ totalCount: counts.at(0)?.total ?? 0 });
  },
);

export default readEntitySummariesCount;
