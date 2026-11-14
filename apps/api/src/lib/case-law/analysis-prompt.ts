import type { AnalysisInputFingerprint } from "@stll/legal-ast/analysis";
/**
 * Shared base for all language-specific analysis prompts.
 *
 * The output JSON schema is enforced by TanStack AI structured
 * output with a Valibot schema; no textual schema description needed.
 */
import {
  ANALYSIS_ABSTRACT_MAX_ANCHORS,
  ANALYSIS_ABSTRACT_MAX_LENGTH,
  ANALYSIS_HOLDING_MAX_ANCHORS,
  ANALYSIS_HOLDING_MAX_LENGTH,
  ANALYSIS_MAX_TOPICS,
  ANALYSIS_TOPIC_MAX_LENGTH,
} from "@stll/legal-ast/analysis";
import { courtParagraphNumber } from "@stll/legal-ast/court-paragraph-number";
// parser-output-unchanged: SHA-256 ownership changes preserve input bytes, serialization and update order, so stored hashes and parser output remain identical.
import { createSha256 } from "@stll/sha256/bun";

/**
 * Behavioral guidelines shared across all language prompts.
 * Inserted at the end of each language-specific system prompt.
 */
export const ANALYSIS_GUIDELINES = `
## Output rules

1. Headings are a navigation aid with light substantive insights.
2. Boilerplate sections (costs, poučení/Belehrung/instruction, routine
   procedural recitals) get a SINGLE heading with NO annotations.
   Just the heading label — nothing more.
3. Substantively interesting sections (legal reasoning, key factual
   findings, pivotal arguments) get MULTIPLE annotations pointing at
   specific paragraphs with 1-sentence insights.
4. Aim for 5-15 headings and 10-30 annotations total, scaling with
   decision length. Short decisions (< 20 paragraphs) may have fewer.
5. Every anchorId in your output MUST match an anchorId from the
   decision text. Do not invent anchorIds.
6. Write user-visible fields in the decision's language: labels,
   summaries, and text snippets. Do not use English labels for
   non-English decisions.
7. The category field is a stable machine category. Use one of
   facts, procedural-history, reasoning, holding when applicable;
   use a concise language-specific category only when the core
   categories do not fit.
8. Annotations should point at specific paragraphs (narrow
   startAnchorId–endAnchorId ranges), not span entire sections.
9. Annotation summaries: one sentence, stating what the court
   decided or found — not what the section "discusses".
10. A paragraph the court numbered shows its number after the
   anchor, as "(¶ 12)". When text you write refers to a paragraph,
   cite the court's number in the decision's language (for example
   "bod 12", "Rn. 12", "paragraph 12"), never an anchorId. A
   paragraph without "(¶ N)" has no court number: refer to it by what
   it says, never by a number, and never turn an anchorId into a
   paragraph number. Anchor fields still take anchorIds only.

## Cited passages: holding and abstract

The holding and the abstract are each a list of spans, \`{ text, anchors }\`.
The spans' \`text\`, concatenated exactly as written, is the passage.

- Cite each claim where it is made: end a span on the last word of a
  claim, and give that span the start/end anchorId ranges of the
  paragraphs that claim rests on. The reader draws those citations right
  after the span, inside the sentence, next to the claim they support.
- A span may end mid-sentence. The next span starts with whatever
  follows, its leading space or punctuation included (", a druhý z
  rodičů…", " The court…").
- Never collect the citations at the end of the passage, and never put
  every citation on the last span.
- A span that states no claim of its own (a connective, the legal
  question) has empty \`anchors\`.
- Never write a paragraph number or an anchorId into \`text\`: the
  anchors are the citations.

## holding

The legal proposition this decision stands for: the sentence a lawyer
would quote when citing it as authority.

- One or two sentences, at most ${String(ANALYSIS_HOLDING_MAX_LENGTH)} characters.
- State the rule, not the procedure: what the court held the law to be,
  in terms that apply beyond this case's parties.
- Not a summary of the document, not the disposition ("the appeal was
  dismissed"), not a description ("the court dealt with limitation").
- Up to ${String(ANALYSIS_HOLDING_MAX_ANCHORS)} cited ranges in all, from the same anchorIds the
  annotations use. Cite the paragraphs that carry each part of the rule,
  not the whole reasoning section.

## abstract

The decision in one paragraph, 5 to 8 sentences, at most
${String(ANALYSIS_ABSTRACT_MAX_LENGTH)} characters, in this order:

1. the facts, in one sentence;
2. the legal question the court had to answer;
3. the reasoning, in two or three sentences;
4. the outcome;
5. what it changes against the prior case law, or that it changes nothing.

Write prose, not a list, and no headings. Cite the facts, each step of
the reasoning and the outcome, up to ${String(ANALYSIS_ABSTRACT_MAX_ANCHORS)} ranges in all.

## topics

Up to ${String(ANALYSIS_MAX_TOPICS)} short subject labels, each at most ${String(ANALYSIS_TOPIC_MAX_LENGTH)} characters:
the areas of law and the specific institutes this decision turns on
(for example the equivalent, in the decision's language, of "limitation
period", "unjust enrichment", "administrative review"). Noun phrases, no
sentences, no case numbers, no court names, no duplicates.

Every field above is user-visible, so write all of them in the decision's
language.
`;

/** A block as the prompt renders it: its anchor, text and court number. */
export type PromptBlock = {
  anchorId: string;
  plainText: string;
  type: string;
  /** The court's own paragraph number, when the source numbers paragraphs. */
  number?: number | undefined;
};

/**
 * The court's number as the prompt prints it after the anchor, or nothing.
 * The reader's own rule decides what counts as a citable court number.
 */
const courtNumberLabel = (block: PromptBlock): string => {
  const number = courtParagraphNumber(block);
  return number === null ? "" : ` (¶ ${String(number)})`;
};

/**
 * Format the decision text with anchor markers for the AI prompt.
 * Each block is prefixed with its anchorId so the model can
 * reference specific passages, and a paragraph the court numbered
 * carries that number after the anchor, so the model cites the
 * paragraph the way a lawyer would ("bod 12"), not by its anchor.
 */
export const formatDecisionForPrompt = (
  blocks: readonly PromptBlock[],
): string =>
  blocks
    .flatMap((b) =>
      b.plainText.trim().length > 0
        ? [`[${b.anchorId}]${courtNumberLabel(b)} ${b.plainText}`]
        : [],
    )
    .join("\n\n");

export type AnalysisPromptDecision = {
  court: string;
  country: string;
  decisionType: string | null;
  language: string;
};

/**
 * Everything the model is shown for one decision: the system prompt as
 * resolved for the decision's language, and the user message, which
 * carries the metadata header and the anchored text.
 */
export type AnalysisInput = {
  language: string;
  systemPrompt: string;
  userMessage: string;
  fingerprint: AnalysisInputFingerprint;
};

type AnalysisInputOptions = {
  blocks: readonly PromptBlock[];
  decision: AnalysisPromptDecision;
  /** The system prompt already resolved for `decision.language`. */
  systemPrompt: string;
};

const INPUT_SEPARATOR = "\n";

/**
 * The fingerprint a persisted analysis carries: a digest of the complete
 * model input, so it is by construction what the model was shown. The
 * anchors are in the text, so a re-parse that renumbers blocks changes it
 * even when the words do not (the stored notes would then name the wrong
 * paragraphs); a corrected court, type or language changes it too, and so
 * does an edit to the system prompt, since the answer follows all of them.
 */
export const analysisInputOf = ({
  blocks,
  decision,
  systemPrompt,
}: AnalysisInputOptions): AnalysisInput => {
  const userMessage = `Court: ${decision.court}
Country: ${decision.country}
Type: ${decision.decisionType ?? "unknown"}

${formatDecisionForPrompt(blocks)}`;
  const fingerprint = createSha256()
    .update(systemPrompt)
    .update(INPUT_SEPARATOR)
    .update(userMessage)
    .digest("hex");
  return {
    language: decision.language,
    systemPrompt,
    userMessage,
    fingerprint,
  };
};
