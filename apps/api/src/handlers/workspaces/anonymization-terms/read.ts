import { Result } from "better-result";
import { asc, eq } from "drizzle-orm";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
} satisfies HandlerConfig;

/**
 * Read workspace-scoped anonymization terms only. Org-wide
 * defaults are fetched separately via the
 * organization-settings endpoint.
 */
const readWorkspaceAnonymizationTerms = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: anonymizationBlacklistEntries.id,
            label: anonymizationBlacklistEntries.label,
            canonical: anonymizationBlacklistEntries.canonical,
            variants: anonymizationBlacklistEntries.variants,
            enabled: anonymizationBlacklistEntries.enabled,
            createdBy: anonymizationBlacklistEntries.createdBy,
            createdAt: anonymizationBlacklistEntries.createdAt,
          })
          .from(anonymizationBlacklistEntries)
          .where(eq(anonymizationBlacklistEntries.workspaceId, workspaceId))
          // SAFETY: one workspace's blacklist terms, loaded fully for masking/management correctness; the set is bounded by the per-workspace write cap (LIMITS.anonymizationBlacklistEntriesPerWorkspace) enforced in the create endpoint.
          // eslint-disable-next-line require-query-limit/require-query-limit
          .orderBy(asc(anonymizationBlacklistEntries.canonical)),
      ),
    );

    return Result.ok({ entries: rows });
  },
);

export default readWorkspaceAnonymizationTerms;
