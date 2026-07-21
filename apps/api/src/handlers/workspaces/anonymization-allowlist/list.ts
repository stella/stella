import { Result } from "better-result";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationAllowlistEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

/**
 * Anonymization allowlist endpoints.
 *
 * The blacklist (anonymization_blacklist_entries) catalogues
 * "always mask"; this allowlist catalogues "never mask". The
 * inspector's anonymization facet writes here when the user
 * marks a detection as a false positive. The detection pipeline
 * reads all entries that apply at request time and filters its
 * own output.
 *
 * Each entry has one of three scopes; the merge for a single
 * document is the union:
 *   - org-wide    (workspaceId NULL, entityId NULL)
 *   - workspace   (workspaceId set, entityId NULL)
 *   - document    (entityId set; workspaceId carried for RLS)
 *
 * Reads return ALL entries that apply to the requested document
 * so the facet can render the merged list and the pipeline can
 * filter in one pass.
 */

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  access: "read",
  query: t.Object({
    entityId: t.Optional(tSafeId("entity")),
  }),
} satisfies HandlerConfig;

const readWorkspaceAnonymizationAllowlist = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    const entityId = query.entityId ?? null;
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: anonymizationAllowlistEntries.id,
            scope: anonymizationAllowlistEntries.workspaceId,
            workspaceId: anonymizationAllowlistEntries.workspaceId,
            entityId: anonymizationAllowlistEntries.entityId,
            label: anonymizationAllowlistEntries.label,
            canonical: anonymizationAllowlistEntries.canonical,
            createdBy: anonymizationAllowlistEntries.createdBy,
            createdAt: anonymizationAllowlistEntries.createdAt,
          })
          .from(anonymizationAllowlistEntries)
          .where(
            or(
              // Org-wide
              and(
                isNull(anonymizationAllowlistEntries.workspaceId),
                isNull(anonymizationAllowlistEntries.entityId),
              ),
              // Workspace-wide for the current workspace
              and(
                eq(anonymizationAllowlistEntries.workspaceId, workspaceId),
                isNull(anonymizationAllowlistEntries.entityId),
              ),
              // Doc-scoped for the requested entity (only when entityId given)
              entityId === null
                ? undefined
                : and(
                    eq(anonymizationAllowlistEntries.workspaceId, workspaceId),
                    eq(anonymizationAllowlistEntries.entityId, entityId),
                  ),
            ),
          )
          // SAFETY: anonymization allowlist (never-mask overrides) must load fully to avoid over-masking; the workspace + doc-scoped set is bounded by the per-workspace write cap (LIMITS.anonymizationAllowlistEntriesPerWorkspace) enforced in the create endpoint, and org-wide entries are not writable from this endpoint.
          // eslint-disable-next-line require-query-limit/require-query-limit
          .orderBy(asc(anonymizationAllowlistEntries.canonical)),
      ),
    );
    return Result.ok({ entries: rows });
  },
);

export default readWorkspaceAnonymizationAllowlist;
