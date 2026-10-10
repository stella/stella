import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "local-module-loading",
  capability: "Loading local modules inside a declared directory",
  owner: ["packages/start-runtime/src/local-module-loader.ts"],
  summary:
    "The local loader resolves root and entry real paths before importing. scripts/outbound-transport-ownership.ts confines dynamic imports to this owner and enumerates its callers through the transport census; the indirect acquisition ratchet stays at zero.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
