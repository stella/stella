/**
 * Shared base for all language-specific analysis prompts.
 *
 * The output JSON schema is enforced by ai-sdk's Output.object
 * with a Valibot schema; no textual schema description needed.
 */

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
`;

/**
 * Format the decision text with anchor markers for the AI prompt.
 * Each block is prefixed with its anchorId so the model can
 * reference specific passages.
 */
export const formatDecisionForPrompt = (
  blocks: { anchorId: string; plainText: string; type: string }[],
): string =>
  blocks
    .filter((b) => b.plainText.trim().length > 0)
    .map((b) => `[${b.anchorId}] ${b.plainText}`)
    .join("\n\n");
