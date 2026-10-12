import { stampChatDecisionPassageHrefs } from "@stll/api-contract";
import type { SafeId } from "@stll/api-contract/safe-id";
import { courtParagraphNumbersByAnchor } from "@stll/legal-ast/court-paragraph-number";
import type { Block } from "@stll/legal-ast/document-ast";

/**
 * The court paragraph numbers a turn may stamp onto passage citations: per
 * decision whose anchored text the prompt carried, every numbered block by
 * its anchor. It is read from the same AST the prompt rendered, so an anchor
 * the model copied from the prompt resolves against exactly that block.
 */
export type DecisionPassageNumbers = ReadonlyMap<
  SafeId<"caseLawDecision">,
  ReadonlyMap<string, number>
>;

export const NO_DECISION_PASSAGE_NUMBERS: DecisionPassageNumbers = new Map();

export const decisionPassageNumbers = (
  decisionId: SafeId<"caseLawDecision">,
  blocks: readonly Block[],
): DecisionPassageNumbers => {
  const byAnchor = courtParagraphNumbersByAnchor(blocks);
  return byAnchor.size === 0
    ? NO_DECISION_PASSAGE_NUMBERS
    : new Map([[decisionId, byAnchor]]);
};

/**
 * The answer text with every passage citation carrying the number its block
 * was printed with. A citation into a decision the turn did not read keeps no
 * number: one the model wrote is never trusted.
 */
export const stampDecisionPassageNumbers =
  (numbers: DecisionPassageNumbers) =>
  (text: string): string =>
    stampChatDecisionPassageHrefs(
      text,
      ({ anchorId, decisionId }) =>
        numbers.get(decisionId)?.get(anchorId) ?? null,
    );
