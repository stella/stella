import { panic, Result } from "better-result";
import { and, asc, eq, isNull } from "drizzle-orm";

import {
  anonymizationBlacklistEntries,
  organizationSettings,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { LIMITS } from "@/api/lib/limits";

import { readOrCreateOrganizationSettings } from "../read-or-create";

const config = {
  contract: "patch",
  description:
    "Read the organization-wide always-mask terms: each entry's canonical " +
    "form, label, spelling variants, and enabled flag. Matter-scoped terms " +
    "live in the same table but are never returned here; read those with " +
    "matters.anonymization-terms.list.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "anonymization_admin",
    consumesServices: false,
  },
} satisfies HandlerConfig;

// Restrict to org-wide rows (workspace_id IS NULL). Workspace-scoped
// terms created from the inspector live in the same table but are
// managed per-workspace and must not surface in firm-wide settings.
const readAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        await readOrCreateOrganizationSettings({
          tx,
          organizationId: session.activeOrganizationId,
          recordAuditEvent,
        });
        // Serialize the collection snapshot with replacements, which lock this
        // owner row before changing entries and advancing its version.
        const locked = await withAggregateRowQuery({
          tx,
          aggregate: "organizationSettings",
          id: session.activeOrganizationId,
          mode: "share",
          select: (handle) =>
            handle
              .select({
                organizationId: organizationSettings.organizationId,
                updatedAt: organizationSettings.updatedAt,
              })
              .from(organizationSettings),
        });
        if (locked.status === "busy") {
          return panic("Blocking organization settings lock returned busy");
        }
        const settings =
          locked.rows.at(0) ?? panic("Organization settings not found");
        const rows = await boundedAll({
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
        });
        return { entries: rows, updatedAt: settings.updatedAt.toISOString() };
      }),
    );

    return Result.ok(result);
  },
);

export default readAnonymizationBlacklist;
