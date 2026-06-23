/**
 * Collapses items that share an `id`, keeping each id's last occurrence at that
 * occurrence's position. The chat transcript can briefly hold the same message
 * twice — the optimistic streamed copy and the persisted copy carry the same id
 * during the per-turn refetch handoff — which makes React render it twice (same
 * key). Collapsing by id keeps the render idempotent.
 */
export const dedupeById = <T extends { id: string }>(
  items: readonly T[],
): T[] => {
  const lastIndexById = new Map<string, number>();
  items.forEach((item, index) => lastIndexById.set(item.id, index));
  return items.filter((item, index) => lastIndexById.get(item.id) === index);
};
