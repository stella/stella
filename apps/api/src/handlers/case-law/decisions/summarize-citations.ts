import { t } from "elysia";

import { summarizeDecisionCitationsHandler } from "@/api/handlers/case-law/decisions/citation-graph";
import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  mcp: { type: "internal", reason: "public_indexing" },
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
} satisfies PublicHandlerConfig;

/** Citation counts per direction and treatment, and incoming counts by year. */
const summarizeDecisionCitations = createSafePublicSubjectHandler({
  config,
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject) => await summarizeDecisionCitationsHandler({ subject }),
});

export default summarizeDecisionCitations;
