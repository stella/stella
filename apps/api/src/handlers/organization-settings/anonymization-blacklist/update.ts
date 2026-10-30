import { Result } from "better-result";
import * as v from "valibot";

import {
  normalizeAnonymizationBlacklistEntries,
  replaceOrganizationAnonymizationBlacklist,
} from "@/api/lib/anonymization-blacklist";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { LIMITS } from "@/api/lib/limits";

const blacklistEntrySchema = v.object({
  canonical: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  enabled: v.optional(v.boolean()),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  variants: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
      v.maxLength(LIMITS.anonymizationBlacklistVariantsPerEntry),
    ),
  ),
});

const updateAnonymizationBlacklistBodySchema = v.object({
  entries: v.pipe(
    v.array(blacklistEntrySchema),
    v.maxLength(LIMITS.anonymizationBlacklistEntriesPerOrganization),
  ),
});

const config = {
  contract: "replace",
  precondition: {
    type: "deferred",
    baselineId:
      "apps/api/src/handlers/organization-settings/anonymization-blacklist/update.ts",
  },
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
