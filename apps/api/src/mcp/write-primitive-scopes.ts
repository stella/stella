/**
 * The OAuth consent a write primitive spends, whichever surface reaches it.
 *
 * Capability scopes are otherwise chosen by route domain (`fields.*`,
 * `entities.*` → `stella:matters_write`), so a capability that wraps a
 * document write inherited the domain's consent instead of the one the named
 * document tools require. The capability export reads each capability
 * handler's imports and raises its scope to the scope of any primitive listed
 * here, and fails when a pin or covering tool disagrees
 * (`scripts/export-capability-catalog.ts`).
 *
 * Keep entries to functions that write document content: a lower-level helper
 * shared with tasks and other entity kinds (`insertEntityVersion`) would
 * raise unrelated capabilities.
 */
export const WRITE_PRIMITIVE_SCOPES = [
  {
    module: "@/api/handlers/fields/upsert-by-id",
    name: "upsertFieldHandler",
    scope: "stella:documents_write",
  },
  {
    module: "@/api/lib/entities/create-from-buffer",
    name: "createEntityFromBuffer",
    scope: "stella:documents_write",
  },
  {
    module: "@/api/lib/entity-versions/create-entity-version-from-buffer",
    name: "createEntityVersionFromBuffer",
    scope: "stella:documents_write",
  },
  {
    module: "@/api/lib/entity-versions/write-file-version",
    name: "writeFileVersion",
    scope: "stella:documents_write",
  },
] as const;

export type WritePrimitiveScope = (typeof WRITE_PRIMITIVE_SCOPES)[number];
