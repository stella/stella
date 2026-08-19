/**
 * Which properties a kanban card renders as values.
 *
 * A card draws some fields itself — a title, a badge row, a footer — and the
 * rest as generic property values. The split used to be a chain of literal id
 * comparisons inside the card component, which meant the card knew every id the
 * board could hold. Here the caller names its reserved ids once and vetoes the
 * rest through a predicate.
 */

export type KanbanCardFieldSelection = {
  /** Field ids the card renders itself, so they are not repeated as values. */
  reservedFieldIds: readonly string[];
  /**
   * Vetoes a field the board could render but this card should not (a
   * system-computed property whose value the column already conveys, say).
   * Omit to render every unreserved field.
   */
  isRenderable?: ((fieldId: string) => boolean) | undefined;
};

/**
 * The visible field ids a card renders as property values, in view order and
 * without duplicates.
 */
export const selectKanbanCardFieldIds = (
  visibleFieldIds: readonly string[],
  { reservedFieldIds, isRenderable }: KanbanCardFieldSelection,
): string[] => {
  const reserved = new Set(reservedFieldIds);
  const seen = new Set<string>();
  const selected: string[] = [];

  for (const fieldId of visibleFieldIds) {
    if (reserved.has(fieldId) || seen.has(fieldId)) {
      continue;
    }
    seen.add(fieldId);
    if (isRenderable && !isRenderable(fieldId)) {
      continue;
    }
    selected.push(fieldId);
  }

  return selected;
};
