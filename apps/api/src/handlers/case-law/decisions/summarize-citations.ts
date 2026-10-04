import { t } from "elysia";

import { summarizeDecisionCitationsHandler } from "@/api/handlers/case-law/decisions/citation-graph";
import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import { citationSummaryResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import {
  ACCOUNT_ACCESS,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";
import { projectResponseText } from "@/api/lib/search/project-response-text";

const config = {
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    citationSummaryResponseSchema,
  ),
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "public_indexing" },
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
} satisfies PublicHandlerConfig;

/** Citation counts per direction and treatment, and incoming counts by year. */
const summarizeDecisionCitations = createSafePublicSubjectHandler({
  config,
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject) =>
    projectResponseText(
      await summarizeDecisionCitationsHandler({ subject }),
      citationSummaryResponseSchema,
    ),
});

export default summarizeDecisionCitations;
