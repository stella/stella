/**
 * "Apply all accepted": every accepted finding whose proposed wording is not
 * yet in the document becomes one tracked change plus a comment that cites
 * the precedent it came from, in a single editor batch.
 */

import type { FolioAIEditOperation } from "@stll/folio-react";

import type { ReferenceFile } from "@/components/ai-suggestions/document-review-basis.logic";
import { REVIEW_DECISION } from "@/components/ai-suggestions/document-review-queries";
import type {
  ReferenceFinding,
  ReviewFindingFix,
  ReviewFixState,
} from "@/components/ai-suggestions/playbook-review-store";
import { reviewItemDecision } from "@/components/inspector/playbook-review-results.logic";
import type { ReviewResultItem } from "@/components/inspector/playbook-review-results.logic";

export type AcceptedFixPlan = {
  /** The key the fix state is kept under: the reference finding id, or the
   *  playbook position id. */
  findingKey: string;
  /** Set for a reference finding, whose comment state is tracked too. */
  referenceFindingId: string | null;
  fix: ReviewFindingFix;
  comment: string | null;
};

// TODO(i18n): English until the review surface is localized as a whole.
const PRECEDENT_LABEL = "Precedent";
const PLAYBOOK_LABEL = "Playbook";
/** Passages quoted per reference; a comment is a pointer, not a reprint. */
const PASSAGES_PER_REFERENCE = 1;
const PARAGRAPH_SEPARATOR = "\n\n";

const isPending = (state: ReviewFixState | undefined): boolean =>
  state === undefined || state.status === "pending";

/** The comment that travels with an applied change: the recommendation and
 *  the precedent clause it was drawn from, named per reference. */
export const buildPrecedentComment = (
  finding: ReferenceFinding,
  references: readonly ReferenceFile[],
): string | null => {
  const parts: string[] = [];
  const recommendation = finding.recommendation?.trim() ?? "";
  if (recommendation.length > 0) {
    parts.push(recommendation);
  }
  const nameByFieldId = new Map(
    references.map((reference) => [reference.fileFieldId, reference.name]),
  );
  for (const group of finding.referenceCitations) {
    const name = nameByFieldId.get(group.fileFieldId);
    for (const citation of group.citations.slice(0, PASSAGES_PER_REFERENCE)) {
      const label =
        name === undefined ? PRECEDENT_LABEL : `${PRECEDENT_LABEL} (${name})`;
      parts.push(`${label}: “${citation.text}”`);
    }
  }
  return parts.length === 0 ? null : parts.join(PARAGRAPH_SEPARATOR);
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
    if (
      playbook !== null &&
      playbook.fix !== null &&
      isPending(fixStateByFinding[playbook.positionId])
    ) {
      const rationale = playbook.rationale?.trim() ?? "";
      plans.push({
        findingKey: playbook.positionId,
        referenceFindingId: null,
        fix: playbook.fix,
        comment:
          rationale.length === 0
            ? null
            : `${PLAYBOOK_LABEL} (${playbookName}): ${rationale}`,
      });
    }
    if (
      reference !== null &&
      reference.fix !== null &&
      isPending(fixStateByFinding[reference.findingId])
    ) {
      plans.push({
        findingKey: reference.findingId,
        referenceFindingId: reference.findingId,
        fix: reference.fix,
        comment: buildPrecedentComment(reference, references),
      });
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
