export type CaseLawSectionHeading = {
  level: 3 | 4;
};

const ROMAN_SECTION_TITLE_RE =
  /^(?:X{0,3}(?:IX|IV|V?I{0,3}))\.\s+(?:(?<subsection>\p{Lu})\)\s+)?\S.+$/u;
const SECTION_TITLE_MAX_CHARS = 180;

/** Classify a court-authored Roman section title printed on one line. */
export const caseLawSectionHeading = (
  text: string,
): CaseLawSectionHeading | null => {
  if (text.length > SECTION_TITLE_MAX_CHARS) {
    return null;
  }
  const match = ROMAN_SECTION_TITLE_RE.exec(text);
  if (match === null) {
    return null;
  }
  return { level: match.groups?.["subsection"] === undefined ? 3 : 4 };
};
