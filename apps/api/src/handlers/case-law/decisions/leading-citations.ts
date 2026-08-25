import { t } from "elysia";

import {
  listLeadingCitationsHandler,
  listLeadingCitationsQuerySchema,
} from "@/api/handlers/case-law/decisions/citation-graph";
import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  mcp: { type: "internal", reason: "public_indexing" },
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
  query: listLeadingCitationsQuerySchema,
} satisfies PublicHandlerConfig;

/** The most authoritative decisions per treatment, one direction at a time. */
const listLeadingCitations = createSafePublicSubjectHandler({
  config,
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject, { query }) =>
    await listLeadingCitationsHandler({ subject, query }),
});

export default listLeadingCitations;
