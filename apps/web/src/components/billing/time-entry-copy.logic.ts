const MAX_NARRATIVE_EXCERPT_CODE_POINTS = 120;

export const timeEntryNarrativeExcerpt = (narrative: string): string => {
  const codePoints = Array.from(narrative.trim());
  if (codePoints.length <= MAX_NARRATIVE_EXCERPT_CODE_POINTS) {
    return codePoints.join("");
  }
  return `${codePoints.slice(0, MAX_NARRATIVE_EXCERPT_CODE_POINTS).join("")}…`;
};

export const timeEntryActionLabel = (
  action: string,
  narrative: string,
): string => {
  const excerpt = timeEntryNarrativeExcerpt(narrative);
  return excerpt.length > 0 ? `${action}: ${excerpt}` : action;
};
