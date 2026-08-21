import { Result } from "better-result";
import { t } from "elysia";

import { summarizeDecisionCitationsHandler } from "@/api/handlers/case-law/decisions/citation-graph";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  mcp: { type: "internal", reason: "public_indexing" },
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
} satisfies PublicHandlerConfig;

/** Citation counts per direction and treatment, and incoming counts by year. */
const summarizeDecisionCitations = createSafePublicHandler(
  config,
  async function* ({ params: { decisionId } }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await summarizeDecisionCitationsHandler({
            caseLawDb: caseLawPublicReadDb,
            decisionId,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default summarizeDecisionCitations;
