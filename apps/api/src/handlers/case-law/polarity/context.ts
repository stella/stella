/**
 * Extract citation context from decision sections.
 *
 * Pure function — no database or external dependencies.
 */

/**
 * Extract the text surrounding a citation from the decision
 * sections. Returns ~200 characters before and after the
 * citation reference.
 */
export const extractContext = (
  sections: { text: string }[],
  citationText: string,
  sectionIndex: number | null,
): string | null => {
  const section = sectionIndex !== null ? sections[sectionIndex] : undefined;

  const text = section?.text ?? sections.map((s) => s.text).join("\n");
  const idx = text.indexOf(citationText);

  if (idx === -1) {
    return null;
  }

  const start = Math.max(0, idx - 200);
  const end = Math.min(text.length, idx + citationText.length + 200);
  return text.slice(start, end);
};
