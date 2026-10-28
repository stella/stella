import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { caseLawResearchAnswers } from "@/api/db/schema";
import {
  lookupResearchAnswersBodySchema,
  toResearchAnswerResponse,
} from "@/api/handlers/case-law/research/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { LIMITS } from "@/api/lib/limits";

const config = {
  contract: "patch",
  description:
    "The organization's answer cells for the decisions a client has on " +
    "screen, every question column at once. Bounded by the decisions named " +
    "and the columns the organization holds; the client polls this while any " +
    "cell is pending.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  body: lookupResearchAnswersBodySchema,
} satisfies HandlerConfig;

type ReadResearchAnswersOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  decisionIds: SafeId<"caseLawDecision">[];
};

export const readResearchAnswers = async ({
  safeDb,
  organizationId,
  decisionIds,
}: ReadResearchAnswersOptions) =>
  await safeDb(async (tx) => {
    const rows = await tx
      .select()
      .from(caseLawResearchAnswers)
      .where(
        and(
          inArray(caseLawResearchAnswers.decisionId, decisionIds),
          eq(caseLawResearchAnswers.organizationId, organizationId),
        ),
      )
      // At most one cell per (column, decision): the decisions named times
      // the columns an organization may hold bounds the read. The held
      // ceiling, not the create cap, so a grandfathered organization sees
      // every cell rather than a silently cut rectangle.
      .limit(
        decisionIds.length * LIMITS.caseLawResearchColumnsPerOrganizationMax,
      );
    const withdrawal = await readWithdrawnCopyProjection({ values: rows });
    const now = new Date();
    return rows.map((row) =>
      toResearchAnswerResponse(
        row,
        now,
        withdrawal.marker(null, row.decisionId),
      ),
    );
  });

const lookupResearchAnswers = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session }) {
    const answers = yield* Result.await(
      readResearchAnswers({
        safeDb,
        organizationId: session.activeOrganizationId,
        decisionIds: [...new Set(body.decisionIds)],
      }),
    );
    return Result.ok({ items: answers });
  },
);

export default lookupResearchAnswers;
