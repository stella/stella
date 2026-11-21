type PagedOutlineItem = {
  id: string;
  /** The heading's page number, absent while the editor has not resolved it. */
  meta?: string;
};

/**
 * `next` with each heading that lists no page number given the one `previous`
 * showed for it, and `next` itself when there is nothing to carry.
 *
 * Folio re-collects its headings after an edit and lists them without page
 * numbers until the relayout resolves them again. Keeping the last known
 * number holds the outline still in between; a heading whose page did move
 * takes its new number when the relayout reports it.
 */
export const retainOutlinePageNumbers = <Item extends PagedOutlineItem>(
  previous: Item[],
  next: Item[],
): Item[] => {
  const knownPages = new Map<string, string>();
  for (const item of previous) {
    if (item.meta !== undefined) {
      knownPages.set(item.id, item.meta);
    }
  }
  if (knownPages.size === 0) {
    return next;
  }
  const retained = next.map((item) => {
    const known = knownPages.get(item.id);
    return item.meta !== undefined || known === undefined
      ? item
      : { ...item, meta: known };
  });
  return retained.some((item, index) => item !== next[index]) ? retained : next;
};
