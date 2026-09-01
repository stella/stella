import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import {
  caseLawResearchAnswers,
  caseLawResearchColumns,
} from "@/api/db/schema";
import {
  lookupResearchAnswersBodySchema,
  researchTableParamsSchema,
  toResearchAnswerResponse,
} from "@/api/handlers/case-law/research/schema";
import { findResearchTable } from "@/api/handlers/case-law/research/table-access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "The cells of a research table for the decisions a client has on screen, " +
    "every column at once. Bounded by the decisions named and the table's " +
    "column cap; the client polls this while any cell is pending.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
  body: lookupResearchAnswersBodySchema,
} satisfies HandlerConfig;

const lookupResearchAnswers = createSafeRootHandler(
  config,
  async function* ({ body, params: { tableId }, safeDb, session }) {
    const decisionIds = [...new Set(body.decisionIds)];

    const answers = yield* Result.await(
      safeDb(async (tx) => {
        const table = await findResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        if (table === null) {
          return null;
        }
        const rows = await tx
          .select({ answer: caseLawResearchAnswers })
          .from(caseLawResearchAnswers)
          .innerJoin(
            caseLawResearchColumns,
            eq(caseLawResearchColumns.id, caseLawResearchAnswers.columnId),
          )
          .where(
            and(
              eq(caseLawResearchColumns.tableId, tableId),
              inArray(caseLawResearchAnswers.decisionId, decisionIds),
              eq(
                caseLawResearchAnswers.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          // At most one cell per (column, decision): the product of the two
          // caps bounds the read.
          .limit(decisionIds.length * LIMITS.caseLawResearchColumnsPerTable);
        const now = new Date();
        return rows.map((row) => toResearchAnswerResponse(row.answer, now));
      }),
    );
    if (answers === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Research table not found" }),
      );
    }

    return Result.ok({ items: answers });
  },
);

export default lookupResearchAnswers;
