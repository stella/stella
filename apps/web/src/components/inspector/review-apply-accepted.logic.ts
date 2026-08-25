/**
 * "Apply all accepted": every accepted finding whose proposed wording is not
 * yet in the document becomes one tracked change plus a comment that cites
 * the precedent it came from, in a single editor batch.
 */

import { panic } from "better-result";

import type { FolioAIEditOperation } from "@stll/folio-react";

import type { ReferenceFile } from "@/components/ai-suggestions/document-review-basis.logic";
import {
  REVIEW_APPLICATION_STATUS,
  REVIEW_DECISION,
} from "@/components/ai-suggestions/document-review-queries";
import type { ReviewFindingDecisionRow } from "@/components/ai-suggestions/document-review-run.logic";
import type {
  PlaybookFinding,
  ReferenceFinding,
  ReviewFindingFix,
  ReviewFixState,
} from "@/components/ai-suggestions/playbook-review-store";
import { reviewItemDecision } from "@/components/inspector/playbook-review-results.logic";
import type { ReviewResultItem } from "@/components/inspector/playbook-review-results.logic";

export type AcceptedFixPlan = {
  /** Durable finding row that records this edit after it lands. */
  findingId: ReviewFindingDecisionRow["id"];
  /** The key the fix state is kept under: the reference finding id, or the
   *  playbook position id. */
  findingKey: string;
  /** Set for a reference finding, whose comment state is tracked too. */
  referenceFindingId: string | null;
  fix: ReviewFindingFix;
  comment: string | null;
};

// TODO(i18n): English until the review surface is localized as a whole.
/** "Note to draft": the drafting convention for an internal margin note, so
 *  a reader of the markup knows the comment is for the drafting side, not
 *  the counterparty. */
const NOTE_TO_DRAFT_PREFIX = "NTD:";
const PRECEDENT_LABEL = "Precedent";
const PLAYBOOK_LABEL = "Playbook";
/** Passages quoted per reference; a comment is a pointer, not a reprint. */
const PASSAGES_PER_REFERENCE = 1;
const PARAGRAPH_SEPARATOR = "\n\n";

const isPending = (
  applicationStatus: ReviewFindingDecisionRow["applicationStatus"],
  state: ReviewFixState | undefined,
): boolean =>
  applicationStatus === REVIEW_APPLICATION_STATUS.PENDING &&
  (state === undefined || state.status === "pending");

const precedentQuotes = (
  finding: ReferenceFinding,
  references: readonly ReferenceFile[],
): string[] => {
  const nameByFieldId = new Map(
    references.map((reference) => [reference.fileFieldId, reference.name]),
  );
  const quotes: string[] = [];
  for (const group of finding.referenceCitations) {
    const name = nameByFieldId.get(group.fileFieldId);
    for (const citation of group.citations.slice(0, PASSAGES_PER_REFERENCE)) {
      const label =
        name === undefined ? PRECEDENT_LABEL : `${PRECEDENT_LABEL} (${name})`;
      quotes.push(`${label}: “${citation.text}”`);
    }
  }
  return quotes;
};

/** The margin note that travels with a redline: what the change does and
 *  the precedent clause it was drawn from, named per reference. */
export const buildPrecedentComment = (
  finding: ReferenceFinding,
  references: readonly ReferenceFile[],
): string | null => {
  const parts: string[] = [];
  const recommendation = finding.recommendation?.trim() ?? "";
  if (recommendation.length > 0) {
    parts.push(`${NOTE_TO_DRAFT_PREFIX} ${recommendation}`);
  }
  parts.push(...precedentQuotes(finding, references));
  return parts.length === 0 ? null : parts.join(PARAGRAPH_SEPARATOR);
};

/** A drafting note for a finding with no wording to propose: the point to
 *  resolve, then the precedent, so the drafter can act on it later. */
export const buildDraftNote = (
  finding: ReferenceFinding,
  references: readonly ReferenceFile[],
): string | null => {
  const recommendation = finding.recommendation?.trim() ?? "";
  const comparison =
    finding.explanation.type === "comparison"
      ? finding.explanation.text.trim()
      : "";
  const point = recommendation.length > 0 ? recommendation : comparison;
  if (point.length === 0) {
    return null;
  }
  return [
    `${NOTE_TO_DRAFT_PREFIX} ${point}`,
    ...precedentQuotes(finding, references),
  ].join(PARAGRAPH_SEPARATOR);
};

/** The redline a playbook finding proposes, with its rationale as the note. */
type PlaybookFixPlanArgs = {
  findingId: ReviewFindingDecisionRow["id"];
  playbook: PlaybookFinding;
  playbookName: string;
};

export const playbookFixPlan = ({
  findingId,
  playbook,
  playbookName,
}: PlaybookFixPlanArgs): AcceptedFixPlan | null => {
  if (playbook.fix === null) {
    return null;
  }
  const rationale = playbook.rationale?.trim() ?? "";
  return {
    findingId,
    findingKey: playbook.positionId,
    referenceFindingId: null,
    fix: playbook.fix,
    comment:
      rationale.length === 0
        ? null
        : `${NOTE_TO_DRAFT_PREFIX} ${PLAYBOOK_LABEL} (${playbookName}): ${rationale}`,
  };
};

/** The redline a reference finding proposes, with the precedent as the note. */
type ReferenceFixPlanArgs = {
  findingId: ReviewFindingDecisionRow["id"];
  reference: ReferenceFinding;
  references: readonly ReferenceFile[];
};

export const referenceFixPlan = ({
  findingId,
  reference,
  references,
}: ReferenceFixPlanArgs): AcceptedFixPlan | null =>
  reference.fix === null
    ? null
    : {
        findingId,
        findingKey: reference.findingId,
        referenceFindingId: reference.findingId,
        fix: reference.fix,
        comment: buildPrecedentComment(reference, references),
      };

type CollectAcceptedFixesArgs = {
  items: readonly ReviewResultItem[];
  fixStateByFinding: Record<string, ReviewFixState>;
  references: readonly ReferenceFile[];
  playbookName: string;
};

/** Accepted findings with a proposed wording that is not in the document
 *  yet, in list order. A topic judged by both bases yields both fixes. */
export const collectAcceptedFixes = ({
  items,
  fixStateByFinding,
  references,
  playbookName,
}: CollectAcceptedFixesArgs): AcceptedFixPlan[] => {
  const plans: AcceptedFixPlan[] = [];
  for (const item of items) {
    if (reviewItemDecision(item) !== REVIEW_DECISION.ACCEPTED) {
      continue;
    }
    const { playbook, reference } = item;
    const playbookRow = item.decisions.find(
      (row) => row.checkKind === "playbook",
    );
    const referenceRow = item.decisions.find(
      (row) => row.checkKind === "reference",
    );
    if (playbook !== null && playbookRow === undefined) {
      return panic(`Playbook result ${item.id} has no finding row`);
    }
    if (reference !== null && referenceRow === undefined) {
      return panic(`Reference result ${item.id} has no finding row`);
    }
    const playbookPlan =
      playbook === null || playbookRow === undefined
        ? null
        : playbookFixPlan({
            findingId: playbookRow.id,
            playbook,
            playbookName,
          });
    if (
      playbookPlan !== null &&
      playbookRow !== undefined &&
      isPending(
        playbookRow.applicationStatus,
        fixStateByFinding[playbookPlan.findingKey],
      )
    ) {
      plans.push(playbookPlan);
    }
    const referencePlan =
      reference === null || referenceRow === undefined
        ? null
        : referenceFixPlan({
            findingId: referenceRow.id,
            reference,
            references,
          });
    if (
      referencePlan !== null &&
      referenceRow !== undefined &&
      isPending(
        referenceRow.applicationStatus,
        fixStateByFinding[referencePlan.findingKey],
      )
    ) {
      plans.push(referencePlan);
    }
  }
  return plans;
};

export type AcceptedFixBatch = {
  operations: FolioAIEditOperation[];
  /** The fix operation id per plan, to read its revision ids back. */
  fixOperationIdByKey: ReadonlyMap<string, string>;
};

type BuildAcceptedFixBatchArgs = {
  plans: readonly AcceptedFixPlan[];
  newId: () => string;
};

/** One editor batch: each fix followed by its comment on the same block, so
 *  a reviewer reading the markup meets the reason next to the change. */
export const buildAcceptedFixBatch = ({
  plans,
  newId,
}: BuildAcceptedFixBatchArgs): AcceptedFixBatch => {
  const operations: FolioAIEditOperation[] = [];
  const fixOperationIdByKey = new Map<string, string>();
  for (const plan of plans) {
    const id = `pb-fix-${newId()}`;
    fixOperationIdByKey.set(plan.findingKey, id);
    const { fix } = plan;
    operations.push(
      fix.kind === "replaceBlock"
        ? { id, type: "replaceBlock", blockId: fix.blockId, text: fix.text }
        : {
            id,
            type: "insertAfterBlock",
            blockId: fix.blockId,
            text: fix.text,
          },
    );
    if (plan.comment !== null) {
      operations.push({
        id: `review-comment-${newId()}`,
        type: "commentOnBlock",
        blockId: fix.blockId,
        comment: { text: plan.comment },
      });
    }
  }
  return { operations, fixOperationIdByKey };
};
