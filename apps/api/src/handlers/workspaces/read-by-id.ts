import { status } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

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
  const data = await scopedDb(async (tx) => {
    const ws = await tx.query.workspaces.findFirst({
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
    });

    if (!ws) {
      return null;
    }

    const orgSettings = await tx.query.organizationSettings.findFirst({
      where: {
        organizationId: { eq: organizationId },
      },
    });

    return { ws, orgSettings };
  });

  if (!data) {
    return status(404);
  }

  const { ws: result, orgSettings } = data;

  if (result.organizationId !== organizationId) {
    return status(403);
  }

  const primaryJurisdiction = orgSettings?.practiceJurisdictions.find(
    (j) => j.isPrimary,
  );
  const primaryJurisdictionCountryCode =
    primaryJurisdiction?.countryCode ?? null;

  return {
    ...result,
    limits: LIMITS,
    primaryJurisdictionCountryCode,
  };
};
