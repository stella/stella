/**
 * Collapses items that share an `id`, keeping each id's last occurrence at that
 * occurrence's position. Returns the original array reference when there are no
 * duplicates, so the common case stays referentially stable for memoized
 * consumers. The chat transcript can briefly hold the same message twice — the
 * optimistic streamed copy and the persisted copy carry the same id during the
 * per-turn refetch handoff — which makes React render it twice (same key).
 */
export const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const lastIndexById = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    lastIndexById.set(item.id, index);
  }
  if (lastIndexById.size === items.length) {
    return items;
  }
  return items.filter((item, index) => lastIndexById.get(item.id) === index);
};
