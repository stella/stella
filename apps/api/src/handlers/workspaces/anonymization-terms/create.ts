import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { normalizeAnonymizationBlacklistEntries } from "@/api/lib/anonymization-blacklist";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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

const config = {
  permissions: { workspace: ["update"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
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
const createWorkspaceAnonymizationTerms = createSafeHandler(
  config,
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
          return { type: "ok" as const, inserted: 0 };
        }

        if (
          existing.length + toInsert.length >
          LIMITS.anonymizationBlacklistEntriesPerWorkspace
        ) {
          return { type: "limit-exceeded" as const };
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

        return { type: "ok" as const, inserted: toInsert.length };
      }),
    );

    if (result.type === "limit-exceeded") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Workspace anonymization term limit reached",
        }),
      );
    }

    return Result.ok({ inserted: result.inserted });
  },
);

export default createWorkspaceAnonymizationTerms;
