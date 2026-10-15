import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "relative-time",
  capability: "Relative and absolute time formatting in the web client",
  owner: ["apps/web/src/lib/relative-time.ts"],
  summary:
    "Relative-time output and the shared date/time format presets come from " +
    "one module bound to the active formatting locale, so a rendered instant " +
    "reads the same wherever it appears. The `require-relative-time-helpers` " +
    "rule enforces it.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
