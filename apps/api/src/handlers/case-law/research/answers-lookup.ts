import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { caseLawResearchAnswers } from "@/api/db/schema";
import {
  lookupResearchAnswersBodySchema,
  toResearchAnswerResponse,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "The organization's answer cells for the decisions a client has on " +
    "screen, every question column at once. Bounded by the decisions named " +
    "and the per-organization column cap; the client polls this while any " +
    "cell is pending.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  body: lookupResearchAnswersBodySchema,
} satisfies HandlerConfig;

const lookupResearchAnswers = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session }) {
    const decisionIds = [...new Set(body.decisionIds)];

    const answers = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select()
          .from(caseLawResearchAnswers)
          .where(
            and(
              inArray(caseLawResearchAnswers.decisionId, decisionIds),
              eq(
                caseLawResearchAnswers.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          // At most one cell per (column, decision): the product of the two
          // caps bounds the read.
          .limit(
            decisionIds.length * LIMITS.caseLawResearchColumnsPerOrganization,
          );
        const now = new Date();
        return rows.map((row) => toResearchAnswerResponse(row, now));
      }),
    );

    return Result.ok({ items: answers });
  },
);

export default lookupResearchAnswers;
