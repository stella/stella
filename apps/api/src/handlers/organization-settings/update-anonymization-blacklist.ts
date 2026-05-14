import { Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { normalizeAnonymizationBlacklistEntries } from "@/api/lib/anonymization-blacklist";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
  permissions: { organizationSettings: ["update"] },
  body: updateAnonymizationBlacklistBodySchema,
} satisfies HandlerConfig;

const updateAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user }) {
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
        const existingRows = await tx
          .select({
            canonical: anonymizationBlacklistEntries.canonical,
            id: anonymizationBlacklistEntries.id,
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
          );

        const existingByCanonical = new Map(
          existingRows.map((row) => [row.canonical.toLocaleLowerCase(), row]),
        );
        const incomingCanonicalKeys = new Set(
          entries.value.map((entry) => entry.canonical.toLocaleLowerCase()),
        );

        const idsToDelete = existingRows
          .filter(
            (row) =>
              !incomingCanonicalKeys.has(row.canonical.toLocaleLowerCase()),
          )
          .map((row) => row.id);

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

        for (const entry of entries.value) {
          const existing = existingByCanonical.get(
            entry.canonical.toLocaleLowerCase(),
          );

          if (existing) {
            await tx
              .update(anonymizationBlacklistEntries)
              .set({
                label: entry.label,
                canonical: entry.canonical,
                variants: entry.variants,
                enabled: entry.enabled,
                updatedBy: user.id,
                updatedAt: now,
              })
              .where(
                and(
                  eq(anonymizationBlacklistEntries.id, existing.id),
                  eq(
                    anonymizationBlacklistEntries.organizationId,
                    session.activeOrganizationId,
                  ),
                  isNull(anonymizationBlacklistEntries.workspaceId),
                ),
              );
            continue;
          }

          await tx.insert(anonymizationBlacklistEntries).values({
            id: createSafeId<"anonymizationBlacklistEntry">(),
            organizationId: session.activeOrganizationId,
            label: entry.label,
            canonical: entry.canonical,
            variants: entry.variants,
            enabled: entry.enabled,
            createdBy: user.id,
            updatedBy: user.id,
          });
        }
      }),
    );

    return Result.ok({ entries: entries.value });
  },
);

export default updateAnonymizationBlacklist;
