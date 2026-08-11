/**
 * The executable plan derived from a run's pinned basis and confirmed topics.
 *
 * One function owns "what must this run produce": the create endpoint stores
 * its size as `total`, and the worker completes a run only when exactly that
 * many finding rows are committed. Deriving both from the same call is what
 * keeps progress and the completion predicate from drifting apart.
 *
 * The plan is a pure function of the run row, so it is recomputable from the
 * pinned snapshot alone — a replayed job plans identically to the first one.
 */

import type { DocumentReviewTopic } from "@/api/lib/document-review/contract";
import {
  basisPlaybook,
  basisReferences,
} from "@/api/lib/document-review/run-contract";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import {
  resolveEffectiveAsk,
  selectEnabledPositions,
} from "@/api/lib/workflow/position-runtime";

/** One playbook position to grade, bound to the topic that confirmed it. */
export type PlannedPlaybookCheck = {
  topicId: string;
  topicTitle: string;
  positionId: string;
  position: Position;
};

export type ReviewRunPlan = {
  playbookChecks: PlannedPlaybookCheck[];
  referenceTopics: DocumentReviewTopic[];
  /** The exact number of finding rows a completed run holds. */
  expectedFindingCount: number;
};

type PlanReviewRunArgs = {
  basis: DocumentReviewRunBasis;
  topics: readonly DocumentReviewTopic[];
};

/**
 * A position produces a finding only when it carries an answerable ASK: an
 * empty question or a file-typed ask column extracts nothing, so the grading
 * pass skips it. Planning the same exclusion keeps `total` honest instead of
 * promising a row the engine will never emit.
 */
const isGradeable = (position: Position): boolean => {
  const ask = resolveEffectiveAsk(position);
  return ask.question.trim().length > 0 && ask.content.type !== "file";
};

export const planReviewRun = ({
  basis,
  topics,
}: PlanReviewRunArgs): ReviewRunPlan => {
  const confirmed = topics.filter((topic) => topic.included);

  const playbook = basisPlaybook(basis);
  const playbookChecks: PlannedPlaybookCheck[] = [];
  if (playbook !== null) {
    const positionsBySourceId = new Map(
      selectEnabledPositions(playbook.definitionSnapshot.positions.items).map(
        (position) => [position.sourceId, position],
      ),
    );
    for (const topic of confirmed) {
      if (topic.type !== "playbook") {
        continue;
      }
      const position = positionsBySourceId.get(topic.positionId);
      if (position === undefined || !isGradeable(position)) {
        continue;
      }
      playbookChecks.push({
        topicId: topic.topicId,
        topicTitle: topic.title,
        positionId: topic.positionId,
        position,
      });
    }
  }

  // A basis with no pinned references runs no comparison at all.
  const referenceTopics: DocumentReviewTopic[] =
    basisReferences(basis).length > 0 ? confirmed : [];

  return {
    playbookChecks,
    referenceTopics,
    expectedFindingCount: playbookChecks.length + referenceTopics.length,
  };
};
