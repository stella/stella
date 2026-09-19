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

import { Result } from "better-result";

import type {
  SystemOneClient,
  SystemOneError,
} from "@/api/lib/typesafe/system-one";
import { choice } from "@/api/lib/typesafe/system-one";

import { CLASSIFIABLE_POLARITIES } from "./consts";
import type { ClassifiablePolarity } from "./consts";
import { POLARITY_GUIDANCE } from "./guidance";

/**
 * Below this confidence the reading goes to the generative tier. Set from the
 * agreement curve in `polarity-system-one-compare.ts`; re-measure when the
 * pinned model moves.
 */
export const SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE = 0.7;

const REQUEST_TIMEOUT_MS = 15_000;

export type SystemOnePolarityReading = {
  polarity: ClassifiablePolarity;
  probabilities: Record<ClassifiablePolarity, number>;
  confidence: number;
  model: string;
  latencyMs: number;
  inputTokens: number;
};

export type ClassifyWithSystemOneOptions = {
  client: SystemOneClient;
  /** Text surrounding the citation (a few sentences). */
  context: string;
  /** The citation reference itself, as it appears in `context`. */
  citationText: string;
  /** ISO language code of the decision text. */
  language: string;
  abortSignal?: AbortSignal | undefined;
};

/** The one question, built once: the vocabulary and its guidance are static. */
const POLARITY_QUESTION = choice(
  {
    task: "How does the citing court treat the decision named in `citation` in `excerpt`?",
    judge:
      "Judge the court's own words. Where `excerpt` only reports what a party or a lower court argued, the court has not yet treated the citation: answer neutral.",
    language_note:
      "`language` names the language of `excerpt`; the criteria quote phrases in Czech, Slovak and English.",
  },
  Object.fromEntries(
    CLASSIFIABLE_POLARITIES.map((polarity) => [
      polarity,
      POLARITY_GUIDANCE[polarity],
    ]),
  ) as Record<ClassifiablePolarity, string>,
);

export const classifyWithSystemOne = async ({
  client,
  context,
  citationText,
  language,
  abortSignal,
}: ClassifyWithSystemOneOptions): Promise<
  Result<SystemOnePolarityReading, SystemOneError>
> => {
  const asked = await client.ask({
    state: { language, citation: citationText, excerpt: context },
    questions: { polarity: POLARITY_QUESTION },
    abortSignal: abortSignal
      ? AbortSignal.any([abortSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (Result.isError(asked)) {
    return asked;
  }
  const { answers, model, latencyMs, usage } = asked.value;
  return Result.ok({
    polarity: answers.polarity.choice,
    probabilities: answers.polarity.probabilities,
    confidence: answers.polarity.confidence,
    model,
    latencyMs,
    inputTokens: usage.inputTokens,
  });
};
