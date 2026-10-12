import {
  chatDecisionPassagesIn,
  stampChatDecisionPassageHrefs,
} from "@stll/api-contract";
import type { SafeId } from "@stll/api-contract/safe-id";
import { courtParagraphNumbersByAnchor } from "@stll/legal-ast/court-paragraph-number";
import type { Block } from "@stll/legal-ast/document-ast";

import { COURT_PARAGRAPH_NUMBER_DECISIONS_MAX } from "@/api/lib/case-law/court-paragraph-numbers";
import type { CourtParagraphNumbersByDecision } from "@/api/lib/case-law/court-paragraph-numbers";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const PASSAGE_NUMBER_LOOKUP_FAILED_SINK = failureSink({
  event: "chat.decision_passage_number_lookup_failed",
  expected: [],
});

/**
 * Court paragraph numbers a turn already holds: per decision, every numbered
 * block by its anchor. A decision present with an empty map was resolved and
 * numbers nothing; an absent one has not been resolved yet.
 */
export type DecisionPassageNumbers = CourtParagraphNumbersByDecision;

/** A decision resolved as numbering no block. */
const NOTHING_NUMBERED: ReadonlyMap<string, number> = new Map();

export const NO_DECISION_PASSAGE_NUMBERS: DecisionPassageNumbers = new Map();

/** The numbers of the decision the prompt rendered, from that very AST. */
export const decisionPassageNumbers = (
  decisionId: SafeId<"caseLawDecision">,
  blocks: readonly Block[] | null,
): DecisionPassageNumbers =>
  new Map([
    [
      decisionId,
      blocks === null
        ? NOTHING_NUMBERED
        : courtParagraphNumbersByAnchor(blocks),
    ],
  ]);

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
  /** Longest a lookup may hold the visible stream; then it counts as failed. */
  timeoutMs?: number | undefined;
};

/**
 * How many decisions one turn may resolve, beside the loader's per-lookup
 * bound. An answer cites a handful; the bounds keep a text stuffed with links
 * from turning a turn into a corpus scan. A decision past them keeps its bare
 * passage.
 */
export const DECISION_PASSAGE_TURN_DECISIONS_MAX = 32;

/**
 * The stream waits on a lookup before it shows the text that needs it, so a
 * slow corpus may cost a citation its number but never stall the answer.
 */
export const DECISION_PASSAGE_LOOKUP_TIMEOUT_MS = 1500;

class DecisionPassageLookupTimeoutError extends Error {
  override name = "DecisionPassageLookupTimeoutError";
}

const withinTimeout = async <T>(
  pending: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DecisionPassageLookupTimeoutError(
          `Court paragraph lookup exceeded ${String(timeoutMs)} ms`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** One per turn: its cache lives as long as the answer it stamps. */
export const createDecisionPassageStamper = ({
  known,
  load,
  timeoutMs = DECISION_PASSAGE_LOOKUP_TIMEOUT_MS,
}: DecisionPassageStamperOptions): DecisionPassageStamper => {
  const resolved = new Map(known);
  let lookupsLeft = DECISION_PASSAGE_TURN_DECISIONS_MAX;
  return {
    prepare: async (text) => {
      const pending = [
        ...new Set(
          chatDecisionPassagesIn(text)
            .map(({ decisionId }) => decisionId)
            .filter((decisionId) => !resolved.has(decisionId)),
        ),
      ];
      // Batches of the loader's bound, in parallel, until the turn's budget is
      // spent. Only the decisions actually sent are marked resolved: one the
      // budget leaves out stays unresolved rather than cached as unnumbered.
      const batches: SafeId<"caseLawDecision">[][] = [];
      while (pending.length > 0 && lookupsLeft > 0) {
        const batch = pending.splice(
          0,
          Math.min(COURT_PARAGRAPH_NUMBER_DECISIONS_MAX, lookupsLeft),
        );
        lookupsLeft -= batch.length;
        batches.push(batch);
      }
      await Promise.all(
        batches.map(async (sent) => {
          // A failed or slow lookup costs the citation its number, never the
          // answer, and is not retried within the turn.
          const loaded = await withinTimeout(load(sent), timeoutMs).catch(
            (error: unknown) => {
              observeFailure(error, {
                sink: PASSAGE_NUMBER_LOOKUP_FAILED_SINK,
              });
              return NO_DECISION_PASSAGE_NUMBERS;
            },
          );
          for (const decisionId of sent) {
            resolved.set(
              decisionId,
              loaded.get(decisionId) ?? NOTHING_NUMBERED,
            );
          }
        }),
      );
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
