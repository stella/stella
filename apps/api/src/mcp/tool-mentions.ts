/**
 * Which tools a piece of agent-facing prose names, and the prose as one
 * surface should read it. Hints, tool descriptions and references are copied
 * into a model's context as instructions; a sentence that names a tool the
 * serving surface does not list sends the model to a call that answers
 * `unknown_tool`.
 *
 * Pure over the two name sets it is handed, so the registry can scope its own
 * projections with it without an import cycle.
 *
 * A multi-word snake_case token is what reads as a tool name to an agent.
 * Single-word names (`search`, `fetch`) are ordinary English words, so they
 * count only when quoted in backticks: "no as-of filter on the search" names
 * no tool, "call `search`" does.
 */
const SNAKE_CASE_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu;
const BACKTICKED_TOKEN = /`([a-z][a-z0-9_]*)`/gu;

/** One sentence per element; the break is the whitespace after `.`, `!` or `?`. */
const SENTENCE_BREAK = /(?<=[.!?])\s+/u;

export type ToolVocabulary = {
  /** Every tool name any surface lists. */
  registered: ReadonlySet<string>;
  /** The tool names the serving surface lists. */
  listed: ReadonlySet<string>;
};

/** Every registered tool the text names, read off the text itself. */
export const namedToolNames = (
  text: string,
  registered: ReadonlySet<string>,
): readonly string[] => [
  ...new Set(
    [
      ...[...text.matchAll(SNAKE_CASE_TOKEN)].map(([token]) => token),
      ...[...text.matchAll(BACKTICKED_TOKEN)].map(([, token]) => token ?? ""),
    ].filter((token) => registered.has(token)),
  ),
];

/** Registered tools the text names that the serving surface does not list. */
export const unlistedToolNames = (
  text: string,
  { listed, registered }: ToolVocabulary,
): readonly string[] =>
  namedToolNames(text, registered).filter((name) => !listed.has(name));

/**
 * The prose as the serving surface should read it: every sentence naming a
 * tool the surface does not list is dropped and the rest is kept verbatim. A
 * text naming only listed tools comes back unchanged (same string). Prose
 * shared across surfaces is therefore written one step per sentence, so a
 * step that needs an unlisted tool falls away on its own. `undefined` when no
 * sentence survives.
 */
export const scopeProseToSurface = (
  text: string,
  vocabulary: ToolVocabulary,
): string | undefined => {
  if (unlistedToolNames(text, vocabulary).length === 0) {
    return text;
  }
  const kept = text
    .split(SENTENCE_BREAK)
    .filter((sentence) => unlistedToolNames(sentence, vocabulary).length === 0);
  return kept.length === 0 ? undefined : kept.join(" ");
};
