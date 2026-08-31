/**
 * One document review run and its findings: the projection both the point read
 * and the history list's `latest` answer with.
 *
 * Bounded by construction: a run holds at most one finding per confirmed
 * position, and the confirmed position list is capped at creation, so this is a
 * point read rather than an unbounded list.
 *
 * It lives here rather than in the endpoint so the two callers share one
 * projection. A history page that carried a hand-copied second version of this
 * shape would drift from the point read the moment either grew a field, and the
 * client seeds the point read's cache entry from it.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */

import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  docxSuggestions,
  documentReviewFindings,
  documentReviewRuns,
  playbookDefinitions,
  playbookDefinitionVersions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tallyDecisions } from "@/api/lib/document-review/decision-counts";
import { resolvePlaybookStaleness } from "@/api/lib/document-review/playbook-staleness";
import { DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX } from "@/api/lib/document-review/run-contract";
import { PLAYBOOK_VERSION_SOURCE } from "@/api/lib/workflow/playbook-positions";

type ReadRunDetailArgs = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  /** Whose playbook library the pinned definition is compared against. */
  organizationId: SafeId<"organization">;
  runId: SafeId<"documentReviewRun">;
};

/**
 * The run, its findings, and how far behind today's playbook it has fallen.
 * `null` when the workspace holds no such run: the point read turns that into a
 * 404, the history list into an absent `latest`.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
export const readDocumentReviewRunDetail = async function* ({
  safeDb,
  workspaceId,
  organizationId,
  runId,
}: ReadRunDetailArgs) {
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
          // What the proposal pass left uncompared, so the results can say how
          // much of the document the checklist never covered.
          skipped: documentReviewRuns.skipped,
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
            eq(documentReviewRuns.id, runId),
            eq(documentReviewRuns.workspaceId, workspaceId),
          ),
        )
        .limit(1),
    ),
  );
  const run = runs.at(0);
  if (run === undefined) {
    return null;
  }

  const findings = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: documentReviewFindings.id,
          positionId: documentReviewFindings.positionId,
          positionTitle: documentReviewFindings.positionTitle,
          outcome: documentReviewFindings.outcome,
          payload: documentReviewFindings.payload,
          decision: documentReviewFindings.decision,
          flags: documentReviewFindings.flags,
          decidedBy: documentReviewFindings.decidedBy,
          decidedAt: documentReviewFindings.decidedAt,
          applicationStatus: documentReviewFindings.applicationStatus,
          appliedBy: documentReviewFindings.appliedBy,
          appliedAt: documentReviewFindings.appliedAt,
          // The staged redline, when the run produced one. At most one row
          // can match: `origin_review_finding_id` is uniquely indexed.
          suggestionId: docxSuggestions.id,
        })
        .from(documentReviewFindings)
        .leftJoin(
          docxSuggestions,
          and(
            eq(
              docxSuggestions.originReviewFindingId,
              documentReviewFindings.id,
            ),
            eq(docxSuggestions.workspaceId, workspaceId),
          ),
        )
        .where(
          and(
            eq(documentReviewFindings.runId, runId),
            eq(documentReviewFindings.workspaceId, workspaceId),
          ),
        )
        .orderBy(
          asc(documentReviewFindings.createdAt),
          asc(documentReviewFindings.id),
        )
        .limit(DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX),
    ),
  );

  // Is the pinned playbook still the one an author would run today? One
  // equality between two version ids, so it is answered on read rather than
  // maintained as a flag every future approval would have to invalidate.
  // An ephemeral pin names no definition, so there is nothing to compare a
  // later approval against.
  const pinned = run.basis.playbook;
  const pinnedDefinitionId = pinned.definitionId;
  const definitions =
    pinnedDefinitionId === null
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
                  eq(playbookDefinitions.id, pinnedDefinitionId),
                  eq(playbookDefinitions.organizationId, organizationId),
                ),
              )
              .limit(1),
          ),
        );
  const definition = definitions.at(0);

  return {
    run: {
      ...run,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt === null ? null : run.startedAt.toISOString(),
      finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
      ...resolvePlaybookStaleness({
        pinned,
        latestVersionId: definition?.latestVersionId ?? null,
        definitionExists: definition !== undefined,
      }),
      decisionCounts: tallyDecisions(findings.map(({ decision }) => decision)),
    },
    findings: findings.map((finding) => ({
      id: finding.id,
      positionId: finding.positionId,
      positionTitle: finding.positionTitle,
      outcome: finding.outcome,
      payload: finding.payload,
      decision: finding.decision,
      flags: finding.flags,
      decidedBy: finding.decidedBy,
      decidedAt:
        finding.decidedAt === null ? null : finding.decidedAt.toISOString(),
      applicationStatus: finding.applicationStatus,
      appliedBy: finding.appliedBy,
      appliedAt:
        finding.appliedAt === null ? null : finding.appliedAt.toISOString(),
      suggestionId: finding.suggestionId,
    })),
  };
};
