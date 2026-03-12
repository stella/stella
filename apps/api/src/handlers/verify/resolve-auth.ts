import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Resolve a verification code to a workspace + entity ID.
 *
 * Scoped to the caller's organization to prevent cross-org
 * information disclosure. The frontend calls this after the
 * user logs in via the `/verify/:code` route.
 */
export const resolveVerificationCodeAuth = async (
  code: string,
  organizationId: SafeId<"organization">,
  scopedDb: ScopedDb,
) => {
  const rows = await scopedDb((tx) =>
    tx
      .select({
        workspaceId: entities.workspaceId,
        entityId: entities.id,
      })
      .from(entityVersions)
      .innerJoin(entities, eq(entityVersions.entityId, entities.id))
      .innerJoin(
        workspaces,
        and(
          eq(entities.workspaceId, workspaces.id),
          eq(workspaces.organizationId, organizationId),
        ),
      )
      .where(eq(entityVersions.verificationCode, code))
      .limit(1),
  );
  const row = rows.at(0);

  if (!row) {
    return status(404);
  }

  return {
    workspaceId: row.workspaceId,
    entityId: row.entityId,
  };
};
