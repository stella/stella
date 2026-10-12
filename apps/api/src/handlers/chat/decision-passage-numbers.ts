import {
  chatDecisionPassagesIn,
  stampChatDecisionPassageHrefs,
} from "@stll/api-contract";
import type { SafeId } from "@stll/api-contract/safe-id";
import { courtParagraphNumbersByAnchor } from "@stll/legal-ast/court-paragraph-number";
import type { Block } from "@stll/legal-ast/document-ast";

import { captureError } from "@/api/lib/analytics/capture";
import type { CourtParagraphNumbersByDecision } from "@/api/lib/case-law/court-paragraph-numbers";

/**
 * Court paragraph numbers a turn already holds: per decision, every numbered
 * block by its anchor. A decision present with an empty map was resolved and
 * numbers nothing; an absent one has not been resolved yet.
 */
export type DecisionPassageNumbers = CourtParagraphNumbersByDecision;

export const NO_DECISION_PASSAGE_NUMBERS: DecisionPassageNumbers = new Map();

/** The numbers of the decision the prompt rendered, from that very AST. */
export const decisionPassageNumbers = (
  decisionId: SafeId<"caseLawDecision">,
  blocks: readonly Block[],
): DecisionPassageNumbers =>
  new Map([[decisionId, courtParagraphNumbersByAnchor(blocks)]]);

/**
 * Stamps the court's number into an answer's passage citations.
 *
 * `prepare` resolves, in one batch, every decision a text cites that the turn
 * has not resolved yet; `stamp` then rewrites the text from what is resolved.
 * A number the model wrote is never kept: an unresolved decision, an unknown
 * anchor or an unnumbered block all stamp the bare passage.
 */
export type DecisionPassageStamper = {
  prepare: (text: string) => Promise<void>;
  stamp: (text: string) => string;
};

type DecisionPassageStamperOptions = {
  /** What the turn resolved before streaming: the open decision's numbers. */
  known: DecisionPassageNumbers;
  /** Resolves decisions the turn has not, through the public corpus gate. */
  load: (
    decisionIds: readonly SafeId<"caseLawDecision">[],
  ) => Promise<DecisionPassageNumbers>;
};

const NOTHING_NUMBERED: ReadonlyMap<string, number> = new Map();

/** One per turn: its cache lives as long as the answer it stamps. */
export const createDecisionPassageStamper = ({
  known,
  load,
}: DecisionPassageStamperOptions): DecisionPassageStamper => {
  const resolved = new Map(known);
  return {
    prepare: async (text) => {
      const pending = [
        ...new Set(
          chatDecisionPassagesIn(text)
            .map(({ decisionId }) => decisionId)
            .filter((decisionId) => !resolved.has(decisionId)),
        ),
      ];
      if (pending.length === 0) {
        return;
      }
      // A failed lookup costs the citation its number, never the answer.
      const loaded = await load(pending).catch((error: unknown) => {
        captureError(error, { source: "chat-decision-passage-numbers" });
        return NO_DECISION_PASSAGE_NUMBERS;
      });
      for (const decisionId of pending) {
        resolved.set(decisionId, loaded.get(decisionId) ?? NOTHING_NUMBERED);
      }
    },
    stamp: (text) =>
      stampChatDecisionPassageHrefs(
        text,
        ({ anchorId, decisionId }) =>
          resolved.get(decisionId)?.get(anchorId) ?? null,
      ),
  };
};

/** A stamper that resolves nothing beyond what it is given. */
export const knownDecisionPassageStamper = (
  known: DecisionPassageNumbers,
): DecisionPassageStamper =>
  createDecisionPassageStamper({
    known,
    load: async () => await Promise.resolve(NO_DECISION_PASSAGE_NUMBERS),
  });
