import { status, t } from "elysia";

import { listDecisionCitationsQuerySchema } from "@/api/handlers/case-law/decisions/citation-graph";
import {
  completeDecisionCitations,
  prepareDecisionCitations,
} from "@/api/handlers/case-law/decisions/citation-passages";
import { createSafePublicSubjectFollowUpHandler } from "@/api/handlers/case-law/decisions/public-subject";
import { citationsResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import {
  ACCOUNT_ACCESS,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { projectResponseText } from "@/api/lib/search/project-response-text";

const config = {
  contract: "patch",
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    citationsResponseSchema,
  ),
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "public_indexing" },
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
  query: listDecisionCitationsQuerySchema,
} satisfies PublicHandlerConfig;

/** One page of the decisions a decision cites, or is cited by. */
const listDecisionCitations = createSafePublicSubjectFollowUpHandler({
  config,
  caseLawDb: caseLawPublicReadDb,
  locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
  read: async (subject, { query }) =>
    await prepareDecisionCitations({
      subject,
      cursor: query.cursor,
      direction: query.direction === "incoming" ? "cited_by" : "cites",
      limit: LIMITS.caseLawDecisionCitationPageSize,
    }),
  followUp: async (prepared) => {
    if (prepared.type === "invalid_cursor") {
      return status(400, { message: "Invalid cursor" });
    }
    const read = await completeDecisionCitations({
      caseLawDb: caseLawPublicReadDb,
      prepared,
    });
    if (read.type === "invalid_cursor") {
      return status(400, { message: "Invalid cursor" });
    }
    return projectResponseText(
      {
        doctrineAvailability: read.page.doctrineAvailability,
        items: read.page.items.map(({ passage: _passage, ...item }) => item),
        limit: prepared.page.limit,
        nextCursor: read.page.nextCursor,
      },
      citationsResponseSchema,
    );
  },
});

export default listDecisionCitations;
