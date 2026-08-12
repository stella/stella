import { Result } from "better-result";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationAllowlistEntries } from "@/api/db/schema";
import {
  ALLOWLIST_READ_BOUND,
  ALLOWLIST_READ_INVARIANT,
} from "@/api/lib/anonymization-allowlist";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { boundedAll } from "@/api/lib/db/bounded-all";

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
  description:
    "Read the never-mask entries that apply in a matter: the " +
    "organization-wide ones plus the matter's own and, when entityId is " +
    "given, that document's own, merged into one list so a detection run can " +
    "be filtered in a single pass.",
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
      safeDb(
        async (tx) =>
          await boundedAll({
            invariant: ALLOWLIST_READ_INVARIANT,
            max: ALLOWLIST_READ_BOUND,
            table: "anonymization_allowlist_entries",
            query: (limit) =>
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
                      eq(
                        anonymizationAllowlistEntries.workspaceId,
                        workspaceId,
                      ),
                      isNull(anonymizationAllowlistEntries.entityId),
                    ),
                    // Doc-scoped for the requested entity (only when entityId given)
                    entityId === null
                      ? undefined
                      : and(
                          eq(
                            anonymizationAllowlistEntries.workspaceId,
                            workspaceId,
                          ),
                          eq(anonymizationAllowlistEntries.entityId, entityId),
                        ),
                  ),
                )
                .orderBy(asc(anonymizationAllowlistEntries.canonical))
                .limit(limit),
          }),
      ),
    );
    return Result.ok({ entries: rows });
  },
);

export default readWorkspaceAnonymizationAllowlist;
