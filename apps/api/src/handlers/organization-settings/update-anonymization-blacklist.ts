import { Result } from "better-result";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { normalizeAnonymizationBlacklistEntries } from "@/api/lib/anonymization-blacklist";
import { loadOrganizationAnonymizationTermsForWrite } from "@/api/lib/anonymization-write-cap";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

const blacklistEntrySchema = t.Object({
  canonical: t.String({ minLength: 1, maxLength: 512 }),
  enabled: t.Optional(t.Boolean()),
  label: t.String({ minLength: 1, maxLength: 64 }),
  variants: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 512 }), {
      maxItems: LIMITS.anonymizationBlacklistVariantsPerEntry,
    }),
  ),
});

const updateAnonymizationBlacklistBodySchema = t.Object({
  entries: t.Array(blacklistEntrySchema, {
    maxItems: LIMITS.anonymizationBlacklistEntriesPerOrganization,
  }),
});

const config = {
  description:
    "Replace the organization-wide always-mask list with the entries you " +
    "pass: terms not in the list are deleted, terms already present are " +
    "updated, and the rest are inserted, so this is a whole-list replacement " +
    "rather than a merge, and an empty list clears every organization-wide " +
    "term. Matter-scoped terms in the same table are left untouched.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  body: updateAnonymizationBlacklistBodySchema,
} satisfies HandlerConfig;

const updateAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const entries = normalizeAnonymizationBlacklistEntries(body.entries);
    if (Result.isError(entries)) {
      return Result.err(entries.error);
    }

    // Restrict every read/write below to org-wide rows
    // (workspace_id IS NULL). Workspace-scoped terms created from
    // the inspector live in the same table and must not be visible
    // to — or deletable by — the firm-wide settings page.
    yield* Result.await(
      safeDb(async (tx) => {
        // Locks the org-wide set for the rest of this transaction. The
        // replace deletes only the rows its own read saw, so two
        // concurrent replacements would otherwise each keep their own
        // set and leave the union of both behind: twice the cap.
        const existingRows = await loadOrganizationAnonymizationTermsForWrite(
          tx,
          session.activeOrganizationId,
        );

        const existingByCanonical = new Map(
          existingRows.map((row) => [row.canonical.toLocaleLowerCase(), row]),
        );
        const incomingCanonicalKeys = new Set(
          entries.value.map((entry) => entry.canonical.toLocaleLowerCase()),
        );

        const idsToDelete: (typeof existingRows)[number]["id"][] = [];
        for (const row of existingRows) {
          if (!incomingCanonicalKeys.has(row.canonical.toLocaleLowerCase())) {
            idsToDelete.push(row.id);
          }
        }

        if (idsToDelete.length > 0) {
          await tx
            .delete(anonymizationBlacklistEntries)
            .where(
              and(
                eq(
                  anonymizationBlacklistEntries.organizationId,
                  session.activeOrganizationId,
                ),
                isNull(anonymizationBlacklistEntries.workspaceId),
                inArray(anonymizationBlacklistEntries.id, idsToDelete),
              ),
            );
        }

        if (entries.value.length === 0) {
          return;
        }

        const now = new Date();

        // One upsert for the whole list. A term already on it keeps its row:
        // the id comes from the read above, so the conflict target is the
        // primary key and `createdBy` survives. A new term gets a fresh id.
        // `setWhere` repeats the tenant scope the per-row update carried, so a
        // row outside this organization's org-wide set stays unreachable.
        const rows = entries.value.map((entry) => ({
          id:
            existingByCanonical.get(entry.canonical.toLocaleLowerCase())?.id ??
            createSafeId<"anonymizationBlacklistEntry">(),
          organizationId: session.activeOrganizationId,
          label: entry.label,
          canonical: entry.canonical,
          variants: entry.variants,
          enabled: entry.enabled,
          createdBy: user.id,
          updatedBy: user.id,
        }));

        await tx
          .insert(anonymizationBlacklistEntries)
          .values(rows)
          .onConflictDoUpdate({
            target: anonymizationBlacklistEntries.id,
            set: {
              label: sql`excluded.label`,
              canonical: sql`excluded.canonical`,
              variants: sql`excluded.variants`,
              enabled: sql`excluded.enabled`,
              updatedBy: sql`excluded.updated_by`,
              updatedAt: now,
            },
            setWhere: sql`${anonymizationBlacklistEntries.organizationId} = ${session.activeOrganizationId}
              AND ${anonymizationBlacklistEntries.workspaceId} IS NULL`,
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "anonymizationBlacklist",
            entryCount: entries.value.length,
            deletedCount: idsToDelete.length,
          },
        });
      }),
    );

    return Result.ok({ entries: entries.value });
  },
);

export default updateAnonymizationBlacklist;
