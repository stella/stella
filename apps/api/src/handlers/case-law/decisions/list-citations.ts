import { Result } from "better-result";
import { t } from "elysia";

import {
  listDecisionCitationsHandler,
  listDecisionCitationsQuerySchema,
} from "@/api/handlers/case-law/decisions/citation-graph";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  mcp: { type: "internal", reason: "public_indexing" },
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
  query: listDecisionCitationsQuerySchema,
} satisfies PublicHandlerConfig;

/** One page of the decisions a decision cites, or is cited by. */
const listDecisionCitations = createSafePublicHandler(
  config,
  async function* ({ params: { decisionId }, query }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listDecisionCitationsHandler({
            caseLawDb: caseLawPublicReadDb,
            decisionId,
            query,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default listDecisionCitations;
