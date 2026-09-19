/**
 * System One citation polarity tier.
 *
 * The judgment is one snap reading: how does the citing court treat the
 * decision it names? That is a Choice over the polarity vocabulary, and the
 * answer comes back as a distribution over it rather than a label, so the
 * classifier can accept what the model is sure of and hand the rest to the
 * generative tier, which also extracts the key phrase a rule is promoted
 * from. This tier extracts nothing: a System One model chooses, it does not
 * quote.
 */

import { decide } from "@/api/lib/workflow/decisions/decide";
import type { Decision } from "@/api/lib/workflow/decisions/decide";
import type {
  ChoiceAnswer,
  SystemOneClient,
} from "@/api/lib/workflow/decisions/system-one";
import { choice } from "@/api/lib/workflow/decisions/system-one";

import type { ClassifiablePolarity } from "./consts";
import { POLARITY_GUIDANCE } from "./guidance";

/**
 * Below this confidence the reading goes to the generative tier. Set from the
 * agreement curve in `polarity-system-one-compare.ts`; re-measure when the
 * pinned model moves.
 */
export const SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE = 0.7;

const REQUEST_TIMEOUT_MS = 15_000;

export type ClassifyWithSystemOneOptions = {
  /** Undefined resolves the instance's model; null skips the tier. */
  client: SystemOneClient | null | undefined;
  /** Text surrounding the citation (a few sentences). */
  context: string;
  /** The citation reference itself, as it appears in `context`. */
  citationText: string;
  /** ISO language code of the decision text. */
  language: string;
  abortSignal?: AbortSignal | undefined;
};

/** The one question, built once: the vocabulary and its guidance are static. */
export const POLARITY_QUESTION = choice(
  {
    task: "How does the citing court treat the decision named in `citation` in `excerpt`?",
    judge:
      "Judge the court's own words. Where `excerpt` only reports what a party or a lower court argued, the court has not yet treated the citation: answer neutral.",
    language_note:
      "`language` names the language of `excerpt`; the criteria quote phrases in Czech, Slovak and English.",
  },
  // The guidance is total over the vocabulary, so it is the criteria.
  POLARITY_GUIDANCE,
);

/**
 * The polarity pipeline is corpus background work with no organization behind
 * it, so it asks the instance's decision model rather than an org's.
 */
export const classifyWithSystemOne = async ({
  client,
  context,
  citationText,
  language,
  abortSignal,
}: ClassifyWithSystemOneOptions): Promise<
  Decision<ChoiceAnswer<ClassifiablePolarity>>
> =>
  await decide({
    id: "case-law.polarity",
    orgAIConfig: null,
    state: { language, citation: citationText, excerpt: context },
    question: POLARITY_QUESTION,
    floor: SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE,
    timeoutMs: REQUEST_TIMEOUT_MS,
    abortSignal,
    client: client ? { ...client, keySource: "instance" } : client,
  });
