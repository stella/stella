import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "db-health-config-from-environment",
  capability:
    "Building runtime database health configs from the environment's settings",
  owner: ["apps/api/src/env-online-index.ts"],
  summary:
    "`loadGateHealthConfig()` applies every `DB_LOAD_GATE_*` setting (floors, staleness, timeouts, busy windows) to the package defaults, and every runtime gate config spreads it before its own overrides. " +
    "A gate built from the package's `defaultConfig` instead ignores the environment, so a deployment that clears or moves its busy windows still holds that gate. " +
    "Health decisions in the package take their config explicitly, so no call falls back to the package defaults either. Tests may import the defaults.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/db-load-gate/health"],
    names: ["defaultConfig"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
