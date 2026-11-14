import * as v from "valibot";

import {
  listLeadingCitationsHandler,
  listLeadingCitationsQuerySchema,
} from "@/api/handlers/case-law/decisions/citation-graph";
import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import { leadingCitationsResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
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
    leadingCitationsResponseSchema,
  ),
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "public_indexing" },
  params: v.object({ decisionId: resourceIdSchema("caseLawDecision") }),
  query: listLeadingCitationsQuerySchema,
} satisfies PublicHandlerConfig;

/** The most authoritative decisions per treatment, one direction at a time. */
const listLeadingCitations = createSafePublicSubjectHandler({
  config,
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject, { query }) =>
    projectResponseText(
      await listLeadingCitationsHandler({ subject, query }),
      leadingCitationsResponseSchema,
    ),
});

export default listLeadingCitations;
