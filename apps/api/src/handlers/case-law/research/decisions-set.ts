import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import {
  caseLawResearchTableDecisions,
  caseLawResearchTables,
} from "@/api/db/schema";
import {
  researchTableParamsSchema,
  setResearchTableDecisionBodySchema,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionSummaries } from "@/api/lib/case-law/decision-summaries";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "Pin a decision into a research table or exclude it from the table's " +
    "rows, replacing any earlier disposition. A decision the public may not " +
    "read is a 404; the call is refused once the table holds its maximum " +
    "number of pins and exclusions.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
  body: setResearchTableDecisionBodySchema,
} satisfies HandlerConfig;

const setResearchTableDecision = createSafeRootHandler(
  config,
  async function* ({
    body: { decisionId, disposition },
    params: { tableId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    // The corpus is read through the same gate the public routes use, so a
    // decision that may not be redistributed cannot be pinned by id.
    const summaries = yield* Result.await(
      readPublicDecisionSummaries({
        caseLawDb: caseLawPublicReadDb,
        decisionIds: [decisionId],
      }),
    );
    if (summaries.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Decision not found" }),
      );
    }

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const [table] = await tx
          .select({ id: caseLawResearchTables.id })
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
          return { status: "not-found" as const };
        }
        // The count-and-insert pair is serialized per table so concurrent
        // pins cannot exceed the cap.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${tableId}))`,
        );
        const [aggregate] = await tx
          .select({
            count: sql<number>`count(*)::int`,
            maxPosition: sql<number>`coalesce(max(${caseLawResearchTableDecisions.position}), 0)::int`,
            alreadyPresent: sql<boolean>`bool_or(${caseLawResearchTableDecisions.decisionId} = ${decisionId})`,
          })
          .from(caseLawResearchTableDecisions)
          .where(eq(caseLawResearchTableDecisions.tableId, tableId));
        const count = aggregate?.count ?? 0;
        const alreadyPresent = aggregate?.alreadyPresent ?? false;
        if (
          !alreadyPresent &&
          count >= LIMITS.caseLawResearchTableDecisionsMax
        ) {
          return { status: "limit" as const };
        }
        const position =
          disposition === "pinned" ? (aggregate?.maxPosition ?? 0) + 1 : 0;

        await tx
          .insert(caseLawResearchTableDecisions)
          .values({
            tableId,
            organizationId: session.activeOrganizationId,
            decisionId,
            disposition,
            position,
            addedBy: user.id,
          })
          .onConflictDoUpdate({
            target: [
              caseLawResearchTableDecisions.tableId,
              caseLawResearchTableDecisions.decisionId,
            ],
            set: { disposition, position, addedBy: user.id },
          });
        await tx
          .update(caseLawResearchTables)
          .set({ updatedAt: new Date() })
          .where(
            and(
              eq(caseLawResearchTables.id, tableId),
              eq(
                caseLawResearchTables.organizationId,
                session.activeOrganizationId,
              ),
            ),
          );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
          resourceId: tableId,
          metadata: { decisionId, disposition },
        });
        return { status: "ok" as const, position };
      }),
    );

    switch (outcome.status) {
      case "not-found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Research table not found",
          }),
        );
      case "limit":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Research table decision limit reached",
          }),
        );
      case "ok":
        return Result.ok({
          decisionId,
          disposition,
          position: outcome.position,
          decision: summaries[0] ?? null,
        });
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  },
);

export default setResearchTableDecision;
