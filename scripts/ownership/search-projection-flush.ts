import type { OwnershipEntry } from "../ownership-types.ts";

const FLUSHES_ITS_OWN_SEARCH_MARKS =
  "Flushes the search marks its own transaction committed.";

export default {
  group: "root-connection",
  id: "search-projection-flush",
  capability: "Flushing a mutation's search marks after it commits",
  owner: [
    "apps/api/src/lib/search/projection-repair-flush.ts",
    "apps/api/src/lib/search/workspace-search-activity.ts",
    "apps/api/src/lib/search/pg-fts-maintenance.ts",
  ],
  summary:
    "The repair queue and the search projections are system state that a " +
    "request scope cannot settle. These operations repair exactly the sources " +
    "the caller hands in, whose marks its own transaction committed; the " +
    "scheduled drain runs the same steps on the scheduler's own connection. " +
    "Workspace activity updates derive the projection timestamp from the " +
    "persisted source without loading request-only feature admission into workers.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/lib/search/projection-repair-flush",
      "@/api/lib/search/workspace-search-activity",
      "@/api/lib/search/pg-fts-maintenance",
    ],
    allowed: [
      ...[
        "apps/api/src/handlers/contacts/create.ts",
        "apps/api/src/handlers/contacts/delete.ts",
        "apps/api/src/handlers/contacts/import.ts",
        "apps/api/src/handlers/contacts/update.ts",
        "apps/api/src/handlers/entities/clip.ts",
        "apps/api/src/handlers/entities/copy.ts",
        "apps/api/src/handlers/entities/create.ts",
        "apps/api/src/handlers/entities/duplicate.ts",
        "apps/api/src/handlers/entities/rename-operation.ts",
        "apps/api/src/handlers/entities/versions/delete.ts",
        "apps/api/src/handlers/fields/kanban-placement/update.ts",
        "apps/api/src/handlers/signals/acceptances/create.ts",
        "apps/api/src/handlers/uploads/entity-create-tree.ts",
        "apps/api/src/handlers/workspaces/contacts/create.ts",
        "apps/api/src/handlers/workspaces/contacts/delete.ts",
        "apps/api/src/handlers/workspaces/create.ts",
        "apps/api/src/handlers/workspaces/duplicate.ts",
        "apps/api/src/handlers/workspaces/update.ts",
        "apps/api/src/lib/fields/write-field.ts",
        "apps/api/src/lib/flows/flow-executor.ts",
        "apps/api/src/lib/tasks/create-task-entity.ts",
      ].map((importer) => ({
        path: importer,
        reason:
          importer === "apps/api/src/handlers/entities/copy.ts"
            ? "Updates search marks and activity timestamps after the source copy commits."
            : FLUSHES_ITS_OWN_SEARCH_MARKS,
      })),
      {
        path: "apps/api/src/handlers/entities/move.ts",
        reason:
          "Updates activity projection timestamps after the source move commits.",
      },
      {
        path: "apps/api/src/lib/search/index-entity.ts",
        reason:
          "Synchronizes the projected activity timestamp while repairing its source entity.",
      },
      {
        path: "apps/api/src/lib/search/pg-fts-maintenance.ts",
        reason:
          "Synchronizes the activity projection after removing an entity search row.",
      },
      ...[
        "apps/api/src/handlers/dev/routes.ts",
        "apps/api/src/handlers/entities/delete.ts",
      ].map((path) => ({
        path,
        reason:
          "Repairs or removes search projections from persisted source entities without importing request-only search admission.",
      })),
    ],
  },
} as const satisfies OwnershipEntry;
