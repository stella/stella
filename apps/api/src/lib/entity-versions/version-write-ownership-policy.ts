export const VERSION_WRITE_CAPABILITY = {
  INSERT_VERSION_ROW: "insert-version-row",
  REQUEST_NATIVE_EXTRACTION: "request-native-extraction",
  SET_CURRENT_VERSION: "set-current-version",
  USE_VERSION_UTILS: "use-version-utils",
} as const;

export type VersionWriteCapability =
  (typeof VERSION_WRITE_CAPABILITY)[keyof typeof VERSION_WRITE_CAPABILITY];

// Direct version mutations are exceptional ownership boundaries. Initial
// entity creation, import, restore, deletion, and the two durable edit-session
// protocols cannot use the replacement writer, so each receives only the
// physical mutations its lifecycle requires. File-source writers also own the
// durable extraction request that must commit with the source. The lint rule
// consumes this map, verifies every grant is exercised, and rejects the same
// mutations elsewhere.
export const REVIEWED_VERSION_MUTATION_OWNERS = {
  "handlers/entities/clip.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "handlers/entities/copy-utils.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "handlers/entities/create.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "handlers/entities/delete-version.ts": [
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "handlers/entities/finalize-desktop-edit-session.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
    VERSION_WRITE_CAPABILITY.USE_VERSION_UTILS,
  ],
  "handlers/entities/restore-version.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
    VERSION_WRITE_CAPABILITY.USE_VERSION_UTILS,
  ],
  "handlers/entities/upload.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "lib/tasks/create-task-entity.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "handlers/uploads/entity-create-tree.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "handlers/uploads/entity-version.ts": [
    VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
  ],
  "handlers/workspaces/duplicate.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "lib/entities/create-from-buffer.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "lib/entity-versions/create-entity-version-from-buffer.ts": [
    VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
  ],
  "lib/entity-versions/write-file-version.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
    VERSION_WRITE_CAPABILITY.USE_VERSION_UTILS,
  ],
  "lib/infosoud/agenda-import.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
  "lib/uploads/entity-create.ts": [
    VERSION_WRITE_CAPABILITY.INSERT_VERSION_ROW,
    VERSION_WRITE_CAPABILITY.REQUEST_NATIVE_EXTRACTION,
    VERSION_WRITE_CAPABILITY.SET_CURRENT_VERSION,
  ],
} as const satisfies Record<string, readonly VersionWriteCapability[]>;
