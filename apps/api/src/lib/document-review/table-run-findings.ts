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
 * A document holds at most one active table run, so this path only ever writes
 * into a run it owns (`executor = "table"`). A review someone started from the
 * inspector is never touched.
 */

import { panic } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { properties } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { lockActiveTableRun } from "@/api/lib/db/aggregate-lock";
import type { ReviewWithheldSource } from "@/api/lib/document-review/contract";
import {
  buildDocumentReviewFindingRow,
  writeReviewFindingBatch,
} from "@/api/lib/document-review/finding-write";
import type {
  DocumentReviewFindingRow,
  WriteReviewFindingBatchResult,
} from "@/api/lib/document-review/finding-write";
import { LANGUAGE_DELTA } from "@/api/lib/document-review/review-delta";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import type { DocumentReviewRunErrorCode } from "@/api/lib/document-review/run-contract";
import {
  failReviewRun,
  recordRunWithheldSources,
  reportFinalizedReviewRun,
} from "@/api/lib/document-review/run-finalize";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
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

const loadPlaybookSourceIds = async (
  tx: Transaction,
  {
    workspaceId,
    propertyIds,
  }: {
    workspaceId: SafeId<"workspace">;
    propertyIds: readonly SafeId<"property">[];
  },
) => {
  const rows = await tx
    .select({
      id: properties.id,
      playbookSourceId: properties.playbookSourceId,
    })
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        inArray(properties.id, [...propertyIds]),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.playbookSourceId]));
};

type RecordTableRunDocumentReadArgs = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  /** The columns the batch extracted. */
  propertyIds: readonly SafeId<"property">[];
  read:
    | { type: "tooLarge" }
    | { type: "cut"; withheld: readonly ReviewWithheldSource[] };
};

/**
 * Tells the document's active table run how its extraction read the document.
 * Grading runs a level later and sees only stored cells, so the run hears it
 * from the extraction batch that made the cut.
 *
 * A run has no link to one workflow request, because a run opened while a
 * workflow is in flight is carried by that workflow. What ties a batch to the
 * run is what it read: the pinned version, for one of the run's positions.
 */
export const recordTableRunDocumentRead = async ({
  scopedDb,
  workspaceId,
  entityId,
  entityVersionId,
  propertyIds,
  read,
}: RecordTableRunDocumentReadArgs): Promise<void> => {
  await scopedDb(async (tx) => {
    const run = await lockActiveTableRun(tx, { workspaceId, entityId });
    if (run === undefined || run.entityVersionId !== entityVersionId) {
      return;
    }
    const sourceIds = new Set(
      (await loadPlaybookSourceIds(tx, { workspaceId, propertyIds })).values(),
    );
    const { positions } = planReviewRun({
      basis: run.basis,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE,
    });
    if (!positions.some(({ positionId }) => sourceIds.has(positionId))) {
      return;
    }
    switch (read.type) {
      case "tooLarge":
        await failReviewRun(
          tx,
          { workspaceId, runId: run.id },
          "document_too_large",
        );
        return;
      case "cut": {
        const withheld = read.withheld.filter(
          ({ fileFieldId }) => fileFieldId === run.fileFieldId,
        );
        if (withheld.length > 0) {
          await recordRunWithheldSources(
            tx,
            { workspaceId, runId: run.id },
            withheld,
          );
        }
        return;
      }
      default:
        read satisfies never;
        panic(`Unhandled document read: ${String(read)}`);
    }
  });
};

type RecordedBatch =
  | Exclude<RecordTableRunVerdictsResult, { type: "written" }>
  | {
      type: "batch";
      runId: SafeId<"documentReviewRun">;
      rowCount: number;
      finalized: WriteReviewFindingBatchResult;
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

  const recorded = await scopedDb(async (tx): Promise<RecordedBatch> => {
    // At most one active table run per document, and only a table-executed one
    // is ours to write into.
    const run = await lockActiveTableRun(tx, { workspaceId, entityId });
    if (run === undefined) {
      return { type: "no-run" };
    }

    // The run pinned a version. If the document has moved on since, what was
    // just graded is not what the run promised to judge, so the run fails
    // rather than mixing two versions into one review.
    if (run.entityVersionId !== entityVersionId) {
      await failReviewRun(tx, { workspaceId, runId: run.id }, "pin_unresolved");
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
    const sourceIdByPropertyId = await loadPlaybookSourceIds(tx, {
      workspaceId,
      propertyIds,
    });

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
      await failReviewRun(
        tx,
        { workspaceId, runId: run.id },
        "playbook_check_failed",
      );
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

    const finalized = await writeReviewFindingBatch({
      tx,
      workspaceId,
      rows,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE,
      run,
      entityId,
      expectedFindingCount: plan.expectedFindingCount,
    });
    return { type: "batch", runId: run.id, rowCount: rows.length, finalized };
  });
  if (recorded.type !== "batch") {
    return recorded;
  }
  const { runId, rowCount, finalized } = recorded;
  reportFinalizedReviewRun(finalized, { workspaceId, runId });
  return {
    type: "written",
    findingCount: rowCount,
    completed: finalized.type === "completed",
  };
};
