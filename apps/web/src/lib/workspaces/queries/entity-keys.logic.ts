/**
 * The query keys of a matter's entities, apart from the entity queries: a
 * loading view reads an entity the cache already holds by its key without
 * loading the query module.
 */

/** Every entity query of a matter starts with this. */
export const entitiesRootKey = (workspaceId: string) => [
  "entities",
  workspaceId,
];

/** One entity of a matter, as the entity page reads it. */
export const entityDetailKey = (workspaceId: string, entityId: string) => [
  ...entitiesRootKey(workspaceId),
  entityId,
];
