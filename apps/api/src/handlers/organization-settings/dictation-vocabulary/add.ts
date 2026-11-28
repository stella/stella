import { Result } from "better-result";

import { RESOURCE_TYPE } from "@stll/api-contract";
import {
  dictationTermKey,
  MAX_ORGANIZATION_DICTATION_TERMS,
} from "@stll/api-contract/dictation-vocabulary";

import { dictationVocabularyTerms } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

import {
  countOrganizationTerms,
  dictationTermsBodySchema,
  listedTermKeys,
  lockOrganizationVocabulary,
} from "./terms";

const config = {
  contract: "patch",
  description:
    "Add words to the organization's dictation list, which every member's " +
    "dictation uses to spell names and terms. A word already listed (in " +
    "any case) is skipped. The request is refused whole when the new " +
    "words would take the list over its limit.",
  permissions: { organizationSettings: ["update"] },
  realtime: organizationResourceSetUpdates(RESOURCE_TYPE.ORGANIZATION),
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "organization_admin",
    consumesServices: false,
  },
  body: dictationTermsBodySchema,
  aggregateMutation: {
    type: "aggregate",
    aggregates: ["dictationVocabularyCapacity"],
  },
} satisfies HandlerConfig;

const addDictationVocabulary = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        await lockOrganizationVocabulary(tx, organizationId);
        const total = await countOrganizationTerms(tx, organizationId);
        const words = body.terms.map((term) => ({
          term,
          key: dictationTermKey(term),
        }));
        const listed = await listedTermKeys(
          tx,
          organizationId,
          words.map(({ key }) => key),
        );
        const fresh = words.filter(({ key }) => !listed.has(key));
        if (total + fresh.length > MAX_ORGANIZATION_DICTATION_TERMS) {
          return { type: "full" as const, total, fresh: fresh.length };
        }
        if (fresh.length > 0) {
          await tx.insert(dictationVocabularyTerms).values(
            fresh.map(({ term, key }) => ({
              organizationId,
              term,
              termKey: key,
              createdBy: user.id,
            })),
          );
          // Counts only: a word may name a client.
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: organizationId,
            metadata: { field: "dictationVocabulary", added: fresh.length },
          });
        }
        return {
          type: "added" as const,
          added: fresh.length,
          total: total + fresh.length,
        };
      }),
    );
    if (outcome.type === "full") {
      return Result.err(
        new HandlerError({
          status: 409,
          code: "dictation_vocabulary_full",
          message: `The list holds ${outcome.total} of ${MAX_ORGANIZATION_DICTATION_TERMS} words; ${outcome.fresh} more do not fit`,
          hint: "Delete words you no longer need, or add fewer.",
        }),
      );
    }
    return Result.ok({
      added: outcome.added,
      skipped: body.terms.length - outcome.added,
      total: outcome.total,
    });
  },
);

export default addDictationVocabulary;
