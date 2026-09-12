import { panic, Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import { caseLawResearchColumns } from "@/api/db/schema";
import {
  createResearchColumnBodySchema,
  toResearchColumnResponse,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { defaultResearchColumnTool } from "@/api/lib/case-law/research-answers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "Ask a new question of every decision the organization looks at. " +
    "Answers are produced later, by an explicit run; the column starts " +
    "empty. Refused once the organization holds its maximum number of " +
    "columns.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  body: createResearchColumnBodySchema,
} satisfies HandlerConfig;

const createResearchColumn = createSafeRootHandler(
  config,
  async function* ({ body, recordAuditEvent, safeDb, session, user }) {
    const question = body.question.trim();
    if (question.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "A question is required" }),
      );
    }

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        // Serialize count-and-insert per organization so concurrent adds
        // cannot exceed the cap or share a position.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext('case-law-research-columns'))`,
        );
        const [aggregate] = await tx
          .select({
            count: sql<number>`count(*)::int`,
            maxPosition: sql<number>`coalesce(max(${caseLawResearchColumns.position}), 0)::int`,
          })
          .from(caseLawResearchColumns)
          .where(
            eq(
              caseLawResearchColumns.organizationId,
              session.activeOrganizationId,
            ),
          );
        if (
          (aggregate?.count ?? 0) >=
          LIMITS.caseLawResearchColumnsPerOrganization
        ) {
          return { status: "limit" as const };
        }
        const [row] = await tx
          .insert(caseLawResearchColumns)
          .values({
            id: createSafeId<"caseLawResearchColumn">(),
            organizationId: session.activeOrganizationId,
            createdBy: user.id,
            position: (aggregate?.maxPosition ?? 0) + 1,
            question,
            answerType: body.answerType,
            tool: defaultResearchColumnTool(),
          })
          .returning();
        const column = row ?? panic("Research column insert returned no row");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_COLUMN,
          resourceId: column.id,
          metadata: { answerType: column.answerType },
        });
        return { status: "ok" as const, column };
      }),
    );

    switch (outcome.status) {
      case "limit":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Question column limit reached",
          }),
        );
      case "ok":
        return Result.ok(toResearchColumnResponse(outcome.column));
      default: {
        outcome satisfies never;
        return panic(`Unhandled outcome: ${String(outcome)}`);
      }
    }
  },
);

export default createResearchColumn;
