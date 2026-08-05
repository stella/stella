import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  legalListGenerationCandidates,
  legalListGenerationRuns,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  runId: tSafeId("legalListGenerationRun"),
  candidateId: tSafeId("legalListGenerationCandidate"),
});
const config = {
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: bodySchema,
} satisfies HandlerConfig;

const rejectGenerationCandidate = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const rejected = yield* Result.await(
      safeDb(async (tx) => {
        const run = (
          await tx
            .select({ id: legalListGenerationRuns.id })
            .from(legalListGenerationRuns)
            .where(
              and(
                eq(legalListGenerationRuns.id, body.runId),
                eq(legalListGenerationRuns.listId, body.listId),
                eq(legalListGenerationRuns.workspaceId, workspaceId),
              ),
            )
            .for("update")
        ).at(0);
        if (!run) {
          return false;
        }
        const row = await tx
          .update(legalListGenerationCandidates)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(
            and(
              eq(legalListGenerationCandidates.id, body.candidateId),
              eq(legalListGenerationCandidates.runId, body.runId),
              eq(legalListGenerationCandidates.listId, body.listId),
              eq(legalListGenerationCandidates.workspaceId, workspaceId),
              eq(legalListGenerationCandidates.status, "pending"),
            ),
          )
          .returning({ id: legalListGenerationCandidates.id });
        if (!row.at(0)) {
          return false;
        }
        const pending = await tx.query.legalListGenerationCandidates.findFirst({
          where: {
            runId: { eq: body.runId },
            listId: { eq: body.listId },
            workspaceId: { eq: workspaceId },
            status: { in: ["pending", "accepting"] },
          },
          columns: { id: true },
        });
        if (!pending) {
          await tx
            .update(legalListGenerationRuns)
            .set({ status: "committed", updatedAt: new Date() })
            .where(
              and(
                eq(legalListGenerationRuns.id, body.runId),
                eq(legalListGenerationRuns.listId, body.listId),
                eq(legalListGenerationRuns.workspaceId, workspaceId),
              ),
            );
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
          resourceId: body.runId,
          metadata: {
            operation: "candidate_rejected",
            candidateId: body.candidateId,
          },
        });
        return true;
      }),
    );
    if (!rejected) {
      return Result.err(
        new HandlerError({ status: 409, message: "Candidate is not pending" }),
      );
    }
    return Result.ok({ id: body.candidateId });
  },
);

export default rejectGenerationCandidate;
