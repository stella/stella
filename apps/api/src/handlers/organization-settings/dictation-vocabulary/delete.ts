import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { MAX_DICTATION_TERMS_PER_REQUEST } from "@stll/api-contract/dictation-vocabulary";

import { dictationVocabularyTerms } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema, uniqueItems } from "@/api/lib/custom-schema";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

import { countOrganizationTerms } from "./terms";

const bodySchema = v.strictObject({
  ids: v.pipe(
    v.array(resourceIdSchema("dictationVocabularyTerm")),
    v.minLength(1),
    v.maxLength(MAX_DICTATION_TERMS_PER_REQUEST),
    uniqueItems(),
  ),
});

const config = {
  contract: "patch",
  description:
    "Delete words from the organization's dictation list by id. Ids not in " +
    "the list are ignored. Returns how many were deleted and how many words " +
    "the list still holds.",
  permissions: { organizationSettings: ["update"] },
  realtime: organizationResourceSetUpdates(RESOURCE_TYPE.ORGANIZATION),
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "organization_admin",
    consumesServices: false,
  },
  body: bodySchema,
  aggregateMutation: {
    type: "independent",
    reason:
      "Deletes the organization's own dictation words by id in one statement; the capacity lock bounds only adds, and no matter or document aggregate changes.",
  },
} satisfies HandlerConfig;

const deleteDictationVocabulary = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const deleted = await tx
          .delete(dictationVocabularyTerms)
          .where(
            and(
              eq(dictationVocabularyTerms.organizationId, organizationId),
              inArray(dictationVocabularyTerms.id, body.ids),
            ),
          )
          .returning({ id: dictationVocabularyTerms.id });
        if (deleted.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: organizationId,
            metadata: { field: "dictationVocabulary", deleted: deleted.length },
          });
        }
        return {
          deleted: deleted.length,
          total: await countOrganizationTerms(tx, organizationId),
        };
      }),
    );
    return Result.ok(outcome);
  },
);

export default deleteDictationVocabulary;
