export type FilesystemEntity = { entityId: string; parentId: string | null };

// Walk up the workspace folder skeleton to collect every ancestor folder of the
// matched rows that the filter/search itself did not return. Without these the
// filtered tree orphans deep descendants and the client cannot resolve their
// ancestor chain (e.g. for cross-matter copy dedup) across the hidden folders.
export const collectMissingAncestorIds = (
  matched: readonly FilesystemEntity[],
  parentById: ReadonlyMap<string, string | null>,
): string[] => {
  const presentIds = new Set(matched.map((entity) => entity.entityId));
  const missingIds = new Set<string>();

  for (const entity of matched) {
    const visited = new Set<string>([entity.entityId]);
    let parentId = entity.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (!presentIds.has(parentId)) {
        missingIds.add(parentId);
      }
      parentId = parentById.get(parentId) ?? null;
    }
  }

  return [...missingIds];
};
