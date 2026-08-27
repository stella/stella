/**
 * Read one document review run and its findings.
 *
 * Bounded by construction: a run holds at most one finding per confirmed topic
 * per check kind, and the confirmed topic list is capped at creation, so this
 * is a point read rather than an unbounded list.
 */

import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  documentReviewFindings,
  documentReviewRuns,
  playbookDefinitions,
  playbookDefinitionVersions,
} from "@/api/db/schema";
import { resolvePlaybookStaleness } from "@/api/handlers/document-reviews/playbook-staleness";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { tallyDecisions } from "@/api/lib/document-review/decision-counts";
import { resolveReferenceScope } from "@/api/lib/document-review/reference-access";
import {
  basisPlaybook,
  DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX,
} from "@/api/lib/document-review/run-contract";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PLAYBOOK_VERSION_SOURCE } from "@/api/lib/workflow/playbook-positions";

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
  async function* ({ params, safeDb, session, workspaceId }) {
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
            decision: documentReviewFindings.decision,
            decidedBy: documentReviewFindings.decidedBy,
            decidedAt: documentReviewFindings.decidedAt,
            applicationStatus: documentReviewFindings.applicationStatus,
            appliedBy: documentReviewFindings.appliedBy,
            appliedAt: documentReviewFindings.appliedAt,
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
          .limit(DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX),
      ),
    );

    const scopeReference = yield* Result.await(
      resolveReferenceScope(safeDb, run.basis),
    );

    // Is the pinned playbook still the one an author would run today? One
    // equality between two version ids, so it is answered on read rather than
    // maintained as a flag every future approval would have to invalidate.
    const pinned = basisPlaybook(run.basis);
    const definitions =
      pinned === null
        ? []
        : yield* Result.await(
            safeDb((tx) =>
              tx
                .select({
                  latestVersionId: sql<
                    string | null
                  >`(SELECT ${playbookDefinitionVersions.id}
                       FROM ${playbookDefinitionVersions}
                      WHERE ${playbookDefinitionVersions.playbookDefinitionId} = ${playbookDefinitions.id}
                        AND ${playbookDefinitionVersions.source} = ${PLAYBOOK_VERSION_SOURCE.APPROVAL}
                      ORDER BY ${playbookDefinitionVersions.version} DESC
                      LIMIT 1)`,
                })
                .from(playbookDefinitions)
                .where(
                  and(
                    eq(playbookDefinitions.id, pinned.definitionId),
                    eq(
                      playbookDefinitions.organizationId,
                      session.activeOrganizationId,
                    ),
                  ),
                )
                .limit(1),
            ),
          );
    const definition = definitions.at(0);

    return Result.ok({
      run: {
        ...run,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt === null ? null : run.startedAt.toISOString(),
        finishedAt:
          run.finishedAt === null ? null : run.finishedAt.toISOString(),
        ...resolvePlaybookStaleness({
          pinned,
          latestVersionId: definition?.latestVersionId ?? null,
          definitionExists: definition !== undefined,
        }),
        decisionCounts: tallyDecisions(
          findings.map(({ decision }) => decision),
        ),
      },
      findings: findings.map((finding) => ({
        id: finding.id,
        topicId: finding.topicId,
        topicTitle: finding.topicTitle,
        checkKind: finding.checkKind,
        positionId: finding.positionId,
        outcome: finding.outcome,
        payload: scopeReference(finding.payload),
        decision: finding.decision,
        decidedBy: finding.decidedBy,
        decidedAt:
          finding.decidedAt === null ? null : finding.decidedAt.toISOString(),
        applicationStatus: finding.applicationStatus,
        appliedBy: finding.appliedBy,
        appliedAt:
          finding.appliedAt === null ? null : finding.appliedAt.toISOString(),
      })),
    });
  },
);

export default readDocumentReviewRun;
