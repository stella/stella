/**
 * Read one document review run and its findings.
 *
 * Bounded by construction: a run holds at most one finding per confirmed topic
 * per check kind, and the confirmed topic list is capped at creation, so this
 * is a point read rather than an unbounded list.
 */

import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { DOCUMENT_REVIEW_CHECK_KINDS } from "@/api/lib/document-review/run-contract";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** The most rows a single run can hold: one per confirmed topic per check
 *  kind. Derived from the same caps the create endpoint enforces, so the read
 *  cannot silently outgrow them. */
const FINDINGS_MAX =
  DOCUMENT_REVIEW_LIMITS.topicsMax * DOCUMENT_REVIEW_CHECK_KINDS.length;

const config = {
  description:
    "Read one document review run: its status, progress, pinned basis, and the findings committed so far.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({ runId: tSafeId("documentReviewRun") }),
} satisfies HandlerConfig;

const readDocumentReviewRun = createSafeHandler(
  config,
  async function* ({ params, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: documentReviewRuns.id,
            status: documentReviewRuns.status,
            errorCode: documentReviewRuns.errorCode,
            entityId: documentReviewRuns.entityId,
            fileFieldId: documentReviewRuns.fileFieldId,
            entityVersionId: documentReviewRuns.entityVersionId,
            contentSha256: documentReviewRuns.contentSha256,
            basis: documentReviewRuns.basis,
            topics: documentReviewRuns.topics,
            total: documentReviewRuns.total,
            completed: documentReviewRuns.completed,
            pipelineVersion: documentReviewRuns.pipelineVersion,
            createdAt: documentReviewRuns.createdAt,
            startedAt: documentReviewRuns.startedAt,
            finishedAt: documentReviewRuns.finishedAt,
          })
          .from(documentReviewRuns)
          .where(
            and(
              eq(documentReviewRuns.id, params.runId),
              eq(documentReviewRuns.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    );
    const run = runs.at(0);
    if (run === undefined) {
      return Result.err(
        new HandlerError({ status: 404, message: "Review run not found" }),
      );
    }

    const findings = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: documentReviewFindings.id,
            topicId: documentReviewFindings.topicId,
            topicTitle: documentReviewFindings.topicTitle,
            checkKind: documentReviewFindings.checkKind,
            positionId: documentReviewFindings.positionId,
            outcome: documentReviewFindings.outcome,
            payload: documentReviewFindings.payload,
          })
          .from(documentReviewFindings)
          .where(
            and(
              eq(documentReviewFindings.runId, params.runId),
              eq(documentReviewFindings.workspaceId, workspaceId),
            ),
          )
          .orderBy(
            asc(documentReviewFindings.checkKind),
            asc(documentReviewFindings.createdAt),
            asc(documentReviewFindings.id),
          )
          .limit(FINDINGS_MAX),
      ),
    );

    return Result.ok({
      run: {
        ...run,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt === null ? null : run.startedAt.toISOString(),
        finishedAt:
          run.finishedAt === null ? null : run.finishedAt.toISOString(),
      },
      findings,
    });
  },
);

export default readDocumentReviewRun;
