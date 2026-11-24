import { Result } from "better-result";
import { asc, eq } from "drizzle-orm";

import { MAX_ORGANIZATION_DICTATION_TERMS } from "@stll/api-contract/dictation-vocabulary";

import { dictationVocabularyTerms } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { boundedAll } from "@/api/lib/db/bounded-all";

const config = {
  contract: "patch",
  description:
    "Every word of the organization's dictation list, in alphabetical " +
    "order, for export or backup.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "organization_admin",
    consumesServices: false,
  },
} satisfies HandlerConfig;

const exportDictationVocabulary = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await boundedAll({
            invariant:
              "MAX_ORGANIZATION_DICTATION_TERMS, enforced under a lock by organization-settings/dictation-vocabulary/add.ts",
            max: MAX_ORGANIZATION_DICTATION_TERMS,
            table: "dictation_vocabulary_terms",
            query: async (limit) =>
              await tx
                .select({ term: dictationVocabularyTerms.term })
                .from(dictationVocabularyTerms)
                .where(
                  eq(
                    dictationVocabularyTerms.organizationId,
                    session.activeOrganizationId,
                  ),
                )
                .orderBy(asc(dictationVocabularyTerms.termKey))
                .limit(limit),
          }),
      ),
    );
    return Result.ok({ terms: rows.map(({ term }) => term) });
  },
);

export default exportDictationVocabulary;
