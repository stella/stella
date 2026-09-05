import { Result } from "better-result";
import { and, asc, eq, isNull } from "drizzle-orm";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "Read the organization-wide always-mask terms: each entry's canonical " +
    "form, label, spelling variants, and enabled flag. Matter-scoped terms " +
    "live in the same table but are never returned here; read those with " +
    "matters.anonymization-terms.list.",
  permissions: { organizationSettings: ["update"] },
  access: "read",
  mcp: { type: "capability", reason: "anonymization_admin" },
} satisfies HandlerConfig;

// Restrict to org-wide rows (workspace_id IS NULL). Workspace-scoped
// terms created from the inspector live in the same table but are
// managed per-workspace and must not surface in firm-wide settings.
const readAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await boundedAll({
            invariant:
              "LIMITS.anonymizationBlacklistEntriesPerOrganization, enforced by update-anonymization-blacklist.ts",
            max: LIMITS.anonymizationBlacklistEntriesPerOrganization,
            table: "anonymization_blacklist_entries",
            query: (limit) =>
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
                .orderBy(asc(anonymizationBlacklistEntries.canonical))
                .limit(limit),
          }),
      ),
    );

    return Result.ok({ entries: rows });
  },
);

export default readAnonymizationBlacklist;
