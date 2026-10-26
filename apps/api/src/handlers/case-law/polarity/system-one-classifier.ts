import { decide } from "@/api/lib/workflow/decisions/decide";
import type {
  Decision,
  DecisionGenerator,
} from "@/api/lib/workflow/decisions/decide";
import { decisionConfidenceFloor } from "@/api/lib/workflow/decisions/decision-policy";
import type {
  ChoiceAnswer,
  SystemOneClient,
} from "@/api/lib/workflow/decisions/system-one";
import { choice } from "@/api/lib/workflow/decisions/system-one";

import type { ClassifiablePolarity } from "./consts";
import { POLARITY_GUIDANCE } from "./guidance";
import { polarityGeneration } from "./llm-classifier";

/** Jev's polarity floor; other models use their own calibration. */
export const SYSTEM_ONE_POLARITY_ACCEPT_CONFIDENCE = decisionConfidenceFloor(
  "jev-latest",
  "polarity",
);

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
  generator?: DecisionGenerator | undefined;
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
  generator,
}: ClassifyWithSystemOneOptions): Promise<
  Decision<ChoiceAnswer<ClassifiablePolarity>>
> =>
  await decide({
    dataClass: "public_corpus",
    id: "case-law.polarity",
    orgAIConfig: null,
    state: { language, citation: citationText, excerpt: context },
    question: POLARITY_QUESTION,
    generation: polarityGeneration({
      context,
      citationText,
      language,
      abortSignal,
    }),
    ...(generator === undefined ? {} : { generator }),
    confidencePurpose: "polarity",
    timeoutMs: REQUEST_TIMEOUT_MS,
    abortSignal,
    client: client ? { ...client, keySource: "instance" } : client,
  });
