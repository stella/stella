/**
 * The executable plan derived from a run's pinned basis.
 *
 * One function owns "what must this run produce": the create endpoint stores
 * its size as `total`, and the run completes only when exactly that many
 * finding rows are committed. Deriving both from the same call is what keeps
 * progress and the completion predicate from drifting apart.
 *
 * The plan is a pure function of the run row, so it is recomputable from the
 * pinned snapshot alone — a replayed job plans identically to the first one.
 */

import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewRunBasis,
  DocumentReviewRunExecutor,
} from "@/api/lib/document-review/run-contract";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import {
  resolveEffectiveAsk,
  selectEnabledPositions,
} from "@/api/lib/workflow/position-runtime";

/** `document_review_findings.position_title` is varchar(256). */
const POSITION_TITLE_MAX_LENGTH = 256;

/** One position this run will grade, with the title its finding row carries. */
export type PlannedPosition = {
  positionId: string;
  title: string;
  position: Position;
};

export type ReviewRunPlan = {
  positions: PlannedPosition[];
  /** The exact number of finding rows a completed run holds. */
  expectedFindingCount: number;
};

type PlanReviewRunArgs = {
  basis: DocumentReviewRunBasis;
  /** Who will produce the findings. The two executors can grade different
   *  things, so the promise a run makes has to know which one is coming. */
  executor: DocumentReviewRunExecutor;
};

/**
 * Whether this executor can reach a verdict on this position.
 *
 * The files-table path grades through materialized verdict columns: only a
 * graded position materializes one, and only an authored tier ladder can fill
 * it, so that is all a table run promises. The review worker prepares the
 * document's folio blocks, so it can also compare a reference standard's
 * passages against them directly — a comparison that needs no ASK at all.
 * Everything else produces a finding only when it carries an answerable ASK:
 * an empty question or a file-typed ask column extracts nothing.
 *
 * Planning the same exclusions keeps `total` honest instead of promising a row
 * the engine will never emit.
 */
const isGradeable = (
  position: Position,
  executor: DocumentReviewRunExecutor,
): boolean => {
  const isReferenceStandard =
    position.mode === "graded" && position.standard.source === "reference";
  switch (executor) {
    case DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE:
      if (position.mode !== "graded" || isReferenceStandard) {
        return false;
      }
      break;
    case DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER:
      if (isReferenceStandard) {
        return true;
      }
      break;
    default:
      executor satisfies never;
      return false;
  }
  const ask = resolveEffectiveAsk(position);
  return ask.question.trim().length > 0 && ask.content.type !== "file";
};

export const planReviewRun = ({
  basis,
  executor,
}: PlanReviewRunArgs): ReviewRunPlan => {
  const positions: PlannedPosition[] = [];
  for (const position of selectEnabledPositions(
    basis.playbook.definitionSnapshot.positions.items,
  )) {
    if (!isGradeable(position, executor)) {
      continue;
    }
    positions.push({
      positionId: position.sourceId,
      title: position.issue.slice(0, POSITION_TITLE_MAX_LENGTH),
      position,
    });
  }

  return { positions, expectedFindingCount: positions.length };
};
