import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "portable-path",
  capability: "Repository-relative path identifiers and path containment",
  owner: ["packages/portable-path/"],
  summary:
    "Repository-relative identifiers use forward slashes on every platform, " +
    "while containment resolves paths and retains platform-native semantics.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
