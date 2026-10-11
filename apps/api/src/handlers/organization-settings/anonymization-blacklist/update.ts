import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import {
  normalizeAnonymizationBlacklistEntries,
  replaceOrganizationAnonymizationBlacklist,
} from "@/api/lib/anonymization-blacklist";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { expectedUpdatedAtSchema } from "@/api/lib/optimistic-concurrency";
import { enforceWritePrecondition } from "@/api/lib/write-contract";

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
  expectedUpdatedAt: expectedUpdatedAtSchema,
  entries: t.Array(blacklistEntrySchema, {
    maxItems: LIMITS.anonymizationBlacklistEntriesPerOrganization,
  }),
});

const config = {
  contract: "replace",
  precondition: { type: "updatedAt", field: "expectedUpdatedAt" },
  description:
    "Replace the organization-wide always-mask list with the entries you " +
    "pass: terms not in the list are deleted, terms already present are " +
    "updated, and the rest are inserted, so this is a whole-list replacement " +
    "rather than a merge, and an empty list clears every organization-wide " +
    "term. Matter-scoped terms in the same table are left untouched.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "anonymization_admin",
    consumesServices: false,
  },
  body: updateAnonymizationBlacklistBodySchema,
} satisfies HandlerConfig;

const updateAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const current = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: { updatedAt: true },
        }),
      ),
    );
    if (!current) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Organization settings not found",
        }),
      );
    }
    const preflightConflict = enforceWritePrecondition({
      type: "updatedAt",
      field: "expectedUpdatedAt",
      storedUpdatedAt: current.updatedAt,
      expectedUpdatedAt: body.expectedUpdatedAt,
      resource: "Organization anonymization blacklist",
    });
    if (preflightConflict !== null) {
      return Result.err(preflightConflict);
    }

    const entries = normalizeAnonymizationBlacklistEntries(body.entries);
    if (Result.isError(entries)) {
      return Result.err(entries.error);
    }

    const writeConflict = yield* Result.await(
      safeDb(async (tx) => {
        const locked = await withAggregateRowQuery({
          tx,
          aggregate: "organizationSettings",
          id: session.activeOrganizationId,
          mode: "update",
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
        const stored = locked.rows.at(0);
        if (!stored) {
          return new HandlerError({
            status: 404,
            message: "Organization settings not found",
          });
        }
        const conflict = enforceWritePrecondition({
          type: "updatedAt",
          field: "expectedUpdatedAt",
          storedUpdatedAt: stored.updatedAt,
          expectedUpdatedAt: body.expectedUpdatedAt,
          resource: "Organization anonymization blacklist",
        });
        if (conflict !== null) {
          return conflict;
        }

        const { deletedCount } =
          await replaceOrganizationAnonymizationBlacklist({
            entries: entries.value,
            organizationId: session.activeOrganizationId,
            tx,
            userId: user.id,
          });

        // Outside the write above, and unconditional: clearing the list is
        // the most destructive shape this endpoint has, and it used to
        // return before reaching the audit row.
        await tx
          .update(organizationSettings)
          .set({ updatedAt: new Date() })
          .where(
            eq(
              organizationSettings.organizationId,
              session.activeOrganizationId,
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "anonymizationBlacklist",
            entryCount: entries.value.length,
            deletedCount,
          },
        });
        return null;
      }),
    );
    if (writeConflict !== null) {
      return Result.err(writeConflict);
    }

    return Result.ok({ entries: entries.value });
  },
);

export default updateAnonymizationBlacklist;
