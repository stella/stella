import { Result } from "better-result";

import { readOrganizationResearchColumns } from "@/api/handlers/case-law/research/column-access";
import { toResearchColumnResponse } from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "The organization's case-law question columns, in the order they are " +
    "shown. Every member sees the same set, and the whole set fits one " +
    "response because the per-organization column cap bounds it.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
} satisfies HandlerConfig;

const listResearchColumns = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const columns = yield* Result.await(
      safeDb(
        async (tx) =>
          await readOrganizationResearchColumns({
            tx,
            organizationId: session.activeOrganizationId,
          }),
      ),
    );

    return Result.ok({ items: columns.map(toResearchColumnResponse) });
  },
);

export default listResearchColumns;
