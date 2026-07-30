export const SUGGEST_PROMPT_SYSTEM_PROMPT = `You write extraction prompts for a legal-document AI tool.
Given a column name (and optionally the user's current prompt draft), produce
ONE direct, imperative sentence telling the AI what to extract from the
document. Rules:
- Output the prompt only. No preamble, no quotes, no markdown.
- Single sentence, plain text, ends with a period.
- Write in the same language as the current draft when one is supplied;
  otherwise, write in the same language as the column name. Do not default to
  English merely because these instructions are in English.
- If the user supplied a current draft, REFINE it: keep their intent and
  vocabulary, fix grammar, tighten wording, and align with the result type.
  Do not invent constraints they didn't ask for.
- If no draft, write a fresh prompt grounded in the column name.
- Match the result type:
  - text → ask for the value as a short string.
  - int → ask for a number.
  - date → ask for a date in ISO 8601 (YYYY-MM-DD).
  - single-select → ask the AI to choose exactly one of the listed options.
  - multi-select → ask for all matching options from the list.
- Reference the document implicitly when natural ("from the contract").
- Stay under 280 characters.`;

type BuildSuggestPromptUserMessageOptions = {
  name: string;
  contentType: string;
  options: string[] | undefined;
  currentPrompt: string | undefined;
};

export const buildSuggestPromptUserMessage = ({
  name,
  contentType,
  options,
  currentPrompt,
}: BuildSuggestPromptUserMessageOptions): string => {
  const lines = [`Column name: ${name}`, `Result type: ${contentType}`];
  if (options && options.length > 0) {
    lines.push(`Allowed options: ${options.join(", ")}`);
  }
  if (currentPrompt && currentPrompt.length > 0) {
    lines.push(`Current draft (refine, don't replace): ${currentPrompt}`);
    lines.push("Output language: Match the current draft's language.");
  } else {
    lines.push("Output language: Match the column name's language.");
  }
  lines.push("Write the extraction prompt:");
  return lines.join("\n");
};
