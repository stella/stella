/**
 * Characters the rail tile holds at chip size. `CJEU` is the longest
 * abbreviation the corpus states today, and a fifth character draws past the
 * tile's edge.
 */
const RAIL_ABBREVIATION_MAX_LENGTH = 4;

/**
 * The court's abbreviation as the rail tile can draw it, or null when the
 * tile cannot hold it.
 *
 * Not every court is abbreviated to capitals: a court whose short form is its
 * name written out in prose (`Kúria`) is a word, not a chip, and the tab falls
 * back to the document glyph the same way a court with no abbreviation does.
 */
export const railCourtAbbreviation = (
  abbreviation: string | null | undefined,
): string | null => {
  const trimmed = abbreviation?.trim() ?? "";

  return trimmed.length > 0 && trimmed.length <= RAIL_ABBREVIATION_MAX_LENGTH
    ? trimmed
    : null;
};
