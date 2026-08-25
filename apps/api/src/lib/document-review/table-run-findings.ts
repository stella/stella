/**
 * Durable findings from the files-table review path.
 *
 * The property DAG stays the scheduler: a playbook run still materializes ASK
 * and verdict columns, and the workflow still grades them document by document.
 * What changes is where the judgment lands. A verdict cell holds one tier and
 * dies with its column; a finding holds the tier, the value it was reached
 * from, the reasoning, and the reviewer's disposition, on a run pinned to the
 * playbook snapshot and the document version it judged. So every verdict the
 * batch decides is also committed here, against the run created for that
 * document when the playbook was started.
 *
 * A document holds at most one active run, so this path only ever writes into a
 * run it owns (`executor = "table"`). A review someone started from the
 * inspector is never touched.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { documentReviewRuns, properties } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  buildDocumentReviewFindingRow,
  upsertDocumentReviewFindings,
} from "@/api/lib/document-review/finding-write";
import type { DocumentReviewFindingRow } from "@/api/lib/document-review/finding-write";
import { LANGUAGE_DELTA } from "@/api/lib/document-review/review-delta";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import {
  DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
  DOCUMENT_REVIEW_RUN_EXECUTOR,
} from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewRunBasis,
  DocumentReviewRunErrorCode,
} from "@/api/lib/document-review/run-contract";
import { finalizeReviewRun } from "@/api/lib/document-review/run-finalize";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import { logger } from "@/api/lib/observability/logger";
import type { GradedVerdict } from "@/api/lib/workflow/verdict-engine";

export type RecordTableRunVerdictsArgs = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  graded: readonly GradedVerdict[];
  /** Verdicts this batch decided nothing about: a gate that no longer matches,
   *  or a grading call that failed. Either one means the run's promised finding
   *  set can never be completed. */
  unresolvedPropertyIds: readonly SafeId<"property">[];
};

export type RecordTableRunVerdictsResult =
  | { type: "no-run" }
  | { type: "written"; findingCount: number; completed: boolean }
  | { type: "failed"; errorCode: DocumentReviewRunErrorCode };

/** The run row this path executes against. */
type TableRun = {
  id: SafeId<"documentReviewRun">;
  entityVersionId: SafeId<"entityVersion">;
  fileFieldId: SafeId<"field">;
  basis: DocumentReviewRunBasis;
};

const failRun = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  runId: SafeId<"documentReviewRun">,
  errorCode: DocumentReviewRunErrorCode,
): Promise<void> => {
  // audit: skip — failure bookkeeping on the run row audited at create.
  await tx
    .update(documentReviewRuns)
    .set({ status: "failed", errorCode, finishedAt: new Date() })
    .where(
      and(
        eq(documentReviewRuns.id, runId),
        eq(documentReviewRuns.workspaceId, workspaceId),
        inArray(documentReviewRuns.status, [
          ...DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
        ]),
      ),
    );
};

export const recordTableRunVerdicts = async ({
  scopedDb,
  organizationId,
  workspaceId,
  entityId,
  entityVersionId,
  graded,
  unresolvedPropertyIds,
}: RecordTableRunVerdictsArgs): Promise<RecordTableRunVerdictsResult> => {
  if (graded.length === 0 && unresolvedPropertyIds.length === 0) {
    return { type: "no-run" };
  }

  return await scopedDb(async (tx): Promise<RecordTableRunVerdictsResult> => {
    // At most one active run per document, and only a table-executed one is
    // ours to write into.
    const runs = await tx
      .select({
        id: documentReviewRuns.id,
        entityVersionId: documentReviewRuns.entityVersionId,
        fileFieldId: documentReviewRuns.fileFieldId,
        basis: documentReviewRuns.basis,
      })
      .from(documentReviewRuns)
      .where(
        and(
          eq(documentReviewRuns.workspaceId, workspaceId),
          eq(documentReviewRuns.entityId, entityId),
          eq(documentReviewRuns.executor, DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE),
          inArray(documentReviewRuns.status, [
            ...DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
          ]),
        ),
      )
      .limit(1);
    const run: TableRun | undefined = runs.at(0);
    if (run === undefined) {
      return { type: "no-run" };
    }

    // The run pinned a version. If the document has moved on since, what was
    // just graded is not what the run promised to judge, so the run fails
    // rather than mixing two versions into one review.
    if (run.entityVersionId !== entityVersionId) {
      await failRun(tx, workspaceId, run.id, "pin_unresolved");
      return { type: "failed", errorCode: "pin_unresolved" };
    }

    const plan = planReviewRun({
      basis: run.basis,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE,
    });
    const plannedByPositionId = new Map(
      plan.positions.map((planned) => [planned.positionId, planned]),
    );

    // A verdict column names its position through `playbookSourceId`; the run's
    // pinned snapshot names the same position, which is what binds a graded
    // cell to the topic it answers.
    const propertyIds = [
      ...graded.map((verdict) => verdict.propertyId),
      ...unresolvedPropertyIds,
    ];
    const sourceRows = await tx
      .select({
        id: properties.id,
        playbookSourceId: properties.playbookSourceId,
      })
      .from(properties)
      .where(
        and(
          eq(properties.workspaceId, workspaceId),
          inArray(properties.id, propertyIds),
        ),
      );
    const sourceIdByPropertyId = new Map(
      sourceRows.map((row) => [row.id, row.playbookSourceId]),
    );

    const belongsToRun = (propertyId: SafeId<"property">): boolean => {
      const sourceId = sourceIdByPropertyId.get(propertyId);
      return sourceId !== undefined && sourceId !== null
        ? plannedByPositionId.has(sourceId)
        : false;
    };

    if (unresolvedPropertyIds.some(belongsToRun)) {
      // The run promised one finding per planned position; a position that
      // decided nothing makes that promise unreachable. Fail now instead of
      // leaving the run open until the reconciler notices.
      await failRun(tx, workspaceId, run.id, "playbook_check_failed");
      return { type: "failed", errorCode: "playbook_check_failed" };
    }

    const rows: DocumentReviewFindingRow[] = [];
    for (const verdict of graded) {
      const sourceId = sourceIdByPropertyId.get(verdict.propertyId);
      if (sourceId === undefined || sourceId === null) {
        continue;
      }
      const planned = plannedByPositionId.get(sourceId);
      if (planned === undefined) {
        // A verdict column from another playbook, or from a position this run
        // did not plan. Not this run's finding.
        continue;
      }
      const { position } = planned;
      const finding: ReviewFinding = {
        positionId: sourceId,
        issue: position.issue,
        // The table path plans only graded tier-standard positions, so the
        // neutral tier is unreachable in practice; it keeps the union total.
        severity: position.mode === "graded" ? position.severity : "medium",
        standardSource: "tiers",
        verdict: verdict.verdict,
        // A verdict cell records which tier matched, not what differs; the
        // structured kinds need both texts, which this path never reads.
        delta: LANGUAGE_DELTA,
        extracted: verdict.extracted,
        rationale: verdict.rationale,
        ...(verdict.matchedRef === undefined
          ? {}
          : { matchedRef: verdict.matchedRef }),
        // The table path extracts through the workflow's batch generator, which
        // does not verify folio anchors for the extracted value, so there is
        // nothing to cite and nothing to ground a one-click fix on. The
        // inspector path, which does verify them, fills both.
        citations: [],
        fix: null,
      };
      rows.push(
        buildDocumentReviewFindingRow({
          organizationId,
          workspaceId,
          runId: run.id,
          entityId,
          fileFieldId: run.fileFieldId,
          entityVersionId,
          positionId: sourceId,
          positionTitle: planned.title,
          payload: { finding },
        }),
      );
    }

    await upsertDocumentReviewFindings(tx, rows);

    const finalized = await finalizeReviewRun({
      tx,
      workspaceId,
      runId: run.id,
      entityId,
      fileFieldId: run.fileFieldId,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE,
      expectedFindingCount: plan.expectedFindingCount,
    });
    if (finalized.type === "completed" && finalized.carried > 0) {
      logger.info("document_review_run.decisions_carried", {
        count: String(finalized.carried),
        runId: run.id,
        workspaceId,
      });
    }

    return {
      type: "written",
      findingCount: rows.length,
      completed: finalized.type === "completed",
    };
  });
};
