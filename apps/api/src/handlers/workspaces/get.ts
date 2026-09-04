import { status } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadWorkspaceHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
};

// The organization is part of the lookup, not a check after it. Callers reach
// this handler through an access gate that already resolved `workspaceId`
// inside the caller's organization, and `scopedDb` re-derives that
// authorization in RLS — but this helper is exported, and a caller holding a
// broader scope would otherwise read another tenant's row. Constraining the
// query means a mismatch returns no row, which the not-found path below
// already answers; there is no ownership decision left to make afterwards.
export const readWorkspaceHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
}: ReadWorkspaceHandlerProps) => {
  const result = await scopedDb((tx) =>
    tx.query.workspaces.findFirst({
      where: {
        id: { eq: workspaceId },
        organizationId: { eq: organizationId },
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

  // The matter row and its client card, nothing else. This response used to
  // carry the whole server `LIMITS` table (~7 KiB) on one of the hottest reads
  // in the app, so every new server-side bound inflated every matter load.
  // The two bounds the client actually reads are static product constants it
  // imports from `@stll/api-contract`. Anything genuinely per-org or
  // plan-dependent belongs here as a named subset, never a spread of a table.
  return result;
};
