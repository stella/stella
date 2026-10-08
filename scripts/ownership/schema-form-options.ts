import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "schema-form-options",
  capability: "Web form validation and submission normalization",
  owner: ["apps/web/src/lib/schema.ts"],
  summary:
    "schemaFormOptions wires dynamic validation and requires a schema-output or raw submission choice. " +
    "Valibot owns field transformations; callbacks receive the selected input or output type. " +
    "require-schema-form-options routes every production web form through this contract.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
