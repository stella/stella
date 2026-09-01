import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import {
  caseLawResearchTableDecisions,
  caseLawResearchTables,
} from "@/api/db/schema";
import {
  researchTableParamsSchema,
  toResearchTableResponse,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionSummaries } from "@/api/lib/case-law/decision-summaries";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "Read one research table: its saved query, every pinned or excluded " +
    "decision, and the row facts of the pinned ones so they can be merged " +
    "with the query's own results.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
} satisfies HandlerConfig;

const readResearchTable = createSafeRootHandler(
  config,
  async function* ({ params: { tableId }, safeDb, session }) {
    const loaded = yield* Result.await(
      safeDb(async (tx) => {
        const [table] = await tx
          .select()
          .from(caseLawResearchTables)
          .where(
            and(
              eq(caseLawResearchTables.id, tableId),
              eq(
                caseLawResearchTables.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .limit(1);
        if (table === undefined) {
          return null;
        }
        const decisions = await tx
          .select({
            decisionId: caseLawResearchTableDecisions.decisionId,
            disposition: caseLawResearchTableDecisions.disposition,
            position: caseLawResearchTableDecisions.position,
          })
          .from(caseLawResearchTableDecisions)
          .where(
            and(
              eq(caseLawResearchTableDecisions.tableId, tableId),
              eq(
                caseLawResearchTableDecisions.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .orderBy(
            asc(caseLawResearchTableDecisions.position),
            asc(caseLawResearchTableDecisions.decisionId),
          )
          .limit(LIMITS.caseLawResearchTableDecisionsMax);
        return { table, decisions };
      }),
    );
    if (loaded === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Research table not found" }),
      );
    }

    const pinnedDecisions = yield* Result.await(
      readPublicDecisionSummaries({
        caseLawDb: caseLawPublicReadDb,
        decisionIds: loaded.decisions
          .filter((decision) => decision.disposition === "pinned")
          .map((decision) => decision.decisionId),
      }),
    );

    return Result.ok({
      table: toResearchTableResponse(loaded.table),
      decisions: loaded.decisions,
      pinnedDecisions,
    });
  },
);

export default readResearchTable;
