import { status } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadWorkspaceHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
};

export const readWorkspaceHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
}: ReadWorkspaceHandlerProps) => {
  const result = await scopedDb((tx) =>
    tx.query.workspaces.findFirst({
      where: {
        id: { eq: workspaceId },
      },
      with: {
        client: {
          columns: {
            id: true,
            type: true,
            displayName: true,
            color: true,
          },
        },
      },
    }),
  );

  if (!result) {
    return status(404);
  }

  if (result.organizationId !== organizationId) {
    return status(403);
  }

  // The matter row and its client card, nothing else. This response used to
  // carry the whole server `LIMITS` table (~7 KiB) on one of the hottest reads
  // in the app, so every new server-side bound inflated every matter load.
  // The two bounds the client actually reads are static product constants it
  // imports from `@stll/api-contract`. Anything genuinely per-org or
  // plan-dependent belongs here as a named subset, never a spread of a table.
  return result;
};
