import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  legalListGenerationCandidates,
  legalListGenerationRuns,
} from "@/api/db/schema";
import { commitSettledRun } from "@/api/handlers/lists/generation-candidates/commit-settled-run";
import { legalListRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  runId: tSafeId("legalListGenerationRun"),
  candidateId: tSafeId("legalListGenerationCandidate"),
});
const config = {
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "Reject one pending candidate of a generation run so it is never turned " +
    "into a list item. Only a pending candidate can be rejected; the run " +
    "flips to committed once nothing is left pending. Nothing is deleted: " +
    "the candidate stays in the run with status rejected.",
  permissions: { entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: legalListRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

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
        await commitSettledRun(tx, {
          runId: body.runId,
          listId: body.listId,
          workspaceId,
        });
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
