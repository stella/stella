import { and, eq, isNull, or } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { anonymizationAllowlistEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

/**
 * Server-side helper that returns the canonicals the user (or
 * an org admin) has marked as false positives, so the chat-anon
 * pipeline can pass them through as `excludedCanonicals`.
 *
 * Scopes returned, in the same union the inspector facet shows:
 *   - org-wide                (workspace_id IS NULL, entity_id IS NULL)
 *   - workspace-wide          (workspace_id = $, entity_id IS NULL)
 *   - document-scoped         (workspace_id = $, entity_id = $)
 *
 * When the caller doesn't have an `entityId` (e.g. chat content
 * not tied to a specific file), the document scope is skipped
 * and only the broader two tiers apply.
 */
export const loadAnonymizationAllowlistCanonicals = async ({
  organizationId,
  scopeId,
  entityId,
  scopedDb,
}: {
  organizationId: SafeId<"organization">;
  /**
   * Plain string at the seam so the chat boundary can pass its
   * anonymization scope id directly (which is a workspace UUID
   * for workspace-bound threads and a thread id for global
   * threads — the latter never matches a workspace row, so it
   * collapses cleanly to the org-wide branch).
   */
  scopeId?: string | undefined;
  entityId?: SafeId<"entity"> | undefined;
  scopedDb: ScopedDb;
}): Promise<string[]> => {
  const branded = scopeId ? brandPersistedWorkspaceId(scopeId) : undefined;
  const scopeMatch = branded
    ? or(
        and(
          isNull(anonymizationAllowlistEntries.workspaceId),
          isNull(anonymizationAllowlistEntries.entityId),
        ),
        and(
          eq(anonymizationAllowlistEntries.workspaceId, branded),
          isNull(anonymizationAllowlistEntries.entityId),
        ),
        entityId
          ? and(
              eq(anonymizationAllowlistEntries.workspaceId, branded),
              eq(anonymizationAllowlistEntries.entityId, entityId),
            )
          : undefined,
      )
    : and(
        isNull(anonymizationAllowlistEntries.workspaceId),
        isNull(anonymizationAllowlistEntries.entityId),
      );

  const rows = await scopedDb((tx) =>
    tx
      .select({ canonical: anonymizationAllowlistEntries.canonical })
      .from(anonymizationAllowlistEntries)
      .where(
        and(
          eq(anonymizationAllowlistEntries.organizationId, organizationId),
          scopeMatch,
        ),
      ),
  );

  return rows.map((row) => row.canonical);
};
