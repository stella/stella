import type { OwnershipEntry } from "../ownership-types.ts";

const FLUSHES_ITS_OWN_SEARCH_MARKS =
  "Flushes the search marks its own transaction committed.";

export default {
  group: "root-connection",
  id: "search-projection-flush",
  capability: "Flushing a mutation's search marks after it commits",
  owner: ["apps/api/src/lib/search/projection-repair-flush.ts"],
  summary:
    "The repair queue and the search projections are system state that a " +
    "request scope cannot settle. These operations repair exactly the sources " +
    "the caller hands in, whose marks its own transaction committed; the " +
    "scheduled drain runs the same steps on the scheduler's own connection.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/search/projection-repair-flush"],
    allowed: [
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
      reason: FLUSHES_ITS_OWN_SEARCH_MARKS,
    })),
  },
} as const satisfies OwnershipEntry;
