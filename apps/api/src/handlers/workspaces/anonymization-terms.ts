import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { normalizeAnonymizationBlacklistEntries } from "@/api/lib/anonymization-blacklist";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const termSchema = t.Object({
  canonical: t.String({ minLength: 1, maxLength: 512 }),
  label: t.String({ minLength: 1, maxLength: 64 }),
  variants: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 512 }), {
      maxItems: LIMITS.anonymizationBlacklistVariantsPerEntry,
    }),
  ),
});

const readConfig = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

/**
 * Read workspace-scoped anonymization terms only. Org-wide
 * defaults are fetched separately via the
 * organization-settings endpoint.
 */
export const readWorkspaceAnonymizationTerms = createSafeHandler(
  readConfig,
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
          .orderBy(asc(anonymizationBlacklistEntries.canonical)),
      ),
    );

    return Result.ok({ entries: rows });
  },
);

const createConfig = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    entries: t.Array(termSchema, { minItems: 1, maxItems: 100 }),
  }),
} satisfies HandlerConfig;

/**
 * Create one or more workspace-scoped anonymization terms.
 * On canonical conflict within the workspace the entry is
 * left alone (idempotent re-add). Returns the number of
 * newly inserted rows.
 */
export const createWorkspaceAnonymizationTerms = createSafeHandler(
  createConfig,
  async function* ({
    body,
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const normalized = normalizeAnonymizationBlacklistEntries(body.entries);
    if (Result.isError(normalized)) {
      return Result.err(normalized.error);
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx
          .select({
            id: anonymizationBlacklistEntries.id,
            canonical: anonymizationBlacklistEntries.canonical,
          })
          .from(anonymizationBlacklistEntries)
          .where(eq(anonymizationBlacklistEntries.workspaceId, workspaceId));

        const existingByCanonical = new Map(
          existing.map((row) => [row.canonical.toLocaleLowerCase(), row]),
        );

        const toInsert = normalized.value.filter(
          (entry) =>
            !existingByCanonical.has(entry.canonical.toLocaleLowerCase()),
        );

        if (toInsert.length === 0) {
          return { inserted: 0 };
        }

        const rows = toInsert.map((entry) => ({
          id: createSafeId<"anonymizationBlacklistEntry">(),
          organizationId: session.activeOrganizationId,
          workspaceId,
          label: entry.label,
          canonical: entry.canonical,
          variants: entry.variants,
          enabled: entry.enabled,
          createdBy: user.id,
          updatedBy: user.id,
        }));

        await tx.insert(anonymizationBlacklistEntries).values(rows);

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: workspaceId,
          changes: {
            anonymizationTerms: {
              old: null,
              new: {
                added: rows.map((r) => ({
                  id: r.id,
                  canonical: r.canonical,
                  label: r.label,
                  variantCount: r.variants.length,
                })),
              },
            },
          },
        });

        return { inserted: toInsert.length };
      }),
    );

    return Result.ok(result);
  },
);

const deleteConfig = {
  permissions: { workspace: ["update"] },
  params: t.Object({
    workspaceId: tSafeId("workspace"),
    entryId: tSafeId("anonymizationBlacklistEntry"),
  }),
} satisfies HandlerConfig;

/**
 * Delete a single workspace-scoped term. The WHERE clause
 * scopes the delete to the request's workspace so an org-wide
 * row with the same ID (impossible by design but cheap to
 * guard) can never be removed via this endpoint.
 */
export const deleteWorkspaceAnonymizationTerm = createSafeHandler(
  deleteConfig,
  async function* ({
    params: { entryId },
    safeDb,
    workspaceId,
    recordAuditEvent,
  }) {
    yield* Result.await(
      safeDb(async (tx) => {
        const deleted = await tx
          .delete(anonymizationBlacklistEntries)
          .where(
            and(
              eq(anonymizationBlacklistEntries.id, entryId),
              eq(anonymizationBlacklistEntries.workspaceId, workspaceId),
            ),
          )
          .returning({
            id: anonymizationBlacklistEntries.id,
            canonical: anonymizationBlacklistEntries.canonical,
            label: anonymizationBlacklistEntries.label,
          });

        if (deleted.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            changes: {
              anonymizationTerms: {
                old: { removed: deleted.at(0) },
                new: null,
              },
            },
          });
        }
      }),
    );
    return Result.ok({ success: true as const });
  },
);
