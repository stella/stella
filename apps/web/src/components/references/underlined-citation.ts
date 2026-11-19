/**
 * A citation whose visible words are the answer's own prose: quietly
 * underlined text, never a box. It binds to the punctuation around it as
 * text does, so "(§ 240 odst. 1)" stays tight and never strands a bracket on
 * a line of its own. Decision citations whose prose names the case and
 * inline provision citations share it, so both kinds read alike in a line.
 */
export const UNDERLINED_CITATION_CLASS_NAME =
  "decoration-foreground-placeholder hover:decoration-foreground-muted data-[popup-open]:decoration-foreground-muted rounded-xs underline decoration-dotted underline-offset-2 transition-[text-decoration-color] duration-150";
