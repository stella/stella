import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "field-value-write",
  capability: "Setting a document's field value for a member",
  owner: ["apps/api/src/lib/fields/write-field.ts"],
  summary:
    "REST, MCP, Kanban moves and chat all set a cell through `writeFieldValue`, " +
    "which checks the member's effective authority, takes the entity row lock " +
    "before the cell lock, marks the cell as manually edited and records the " +
    "audit event in one transaction. Writes to the field tables are table " +
    "writes, not imports, so the `no-direct-field-write/no-direct-field-write` " +
    "rule holds this row instead of `confine-owner`; it lists the modules " +
    "that write those tables for other operations.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
