import * as v from "valibot";

import {
  listDecisionCitationsHandler,
  listDecisionCitationsQuerySchema,
} from "@/api/handlers/case-law/decisions/citation-graph";
import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import { citationsResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import {
  ACCOUNT_ACCESS,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { projectResponseText } from "@/api/lib/search/project-response-text";

const config = {
  contract: "patch",
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    citationsResponseSchema,
  ),
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "public_indexing" },
  params: v.object({ decisionId: resourceIdSchema("caseLawDecision") }),
  query: listDecisionCitationsQuerySchema,
} satisfies PublicHandlerConfig;

/** One page of the decisions a decision cites, or is cited by. */
const listDecisionCitations = createSafePublicSubjectHandler({
  config,
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject, { query }) => {
    const result = await listDecisionCitationsHandler({ subject, query });
    if (!("items" in result)) {
      return result;
    }
    return projectResponseText(
      {
        ...result,
        items: result.items.map(
          ({ evidenceQuote: _evidenceQuote, printedBy: _printedBy, ...item }) =>
            item,
        ),
      },
      citationsResponseSchema,
    );
  },
});

export default listDecisionCitations;
