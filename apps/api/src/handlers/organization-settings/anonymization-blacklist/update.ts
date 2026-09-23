import { Result } from "better-result";
import { t } from "elysia";

import {
  normalizeAnonymizationBlacklistEntries,
  replaceOrganizationAnonymizationBlacklist,
} from "@/api/lib/anonymization-blacklist";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
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

    yield* Result.await(
      safeDb(async (tx) => {
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
      }),
    );

    return Result.ok({ entries: entries.value });
  },
);

export default updateAnonymizationBlacklist;
