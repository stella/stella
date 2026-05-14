import { Result } from "better-result";
import { and, asc, eq, isNull } from "drizzle-orm";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { organizationSettings: ["update"] },
} satisfies HandlerConfig;

// Restrict to org-wide rows (workspace_id IS NULL). Workspace-scoped
// terms created from the inspector live in the same table but are
// managed per-workspace and must not surface in firm-wide settings.
const readAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            canonical: anonymizationBlacklistEntries.canonical,
            enabled: anonymizationBlacklistEntries.enabled,
            id: anonymizationBlacklistEntries.id,
            label: anonymizationBlacklistEntries.label,
            variants: anonymizationBlacklistEntries.variants,
          })
          .from(anonymizationBlacklistEntries)
          .where(
            and(
              eq(
                anonymizationBlacklistEntries.organizationId,
                session.activeOrganizationId,
              ),
              isNull(anonymizationBlacklistEntries.workspaceId),
            ),
          )
          .orderBy(asc(anonymizationBlacklistEntries.canonical)),
      ),
    );

    return Result.ok({ entries: rows });
  },
);

export default readAnonymizationBlacklist;
