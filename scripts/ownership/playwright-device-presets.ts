import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "playwright-device-presets",
  capability: "Immutable Playwright device presets for configuration",
  owner: [
    "packages/playwright-tools/src/devices.ts",
    "packages/playwright-tools/src/devices.gen.ts",
    "scripts/generate-playwright-devices.ts",
  ],
  summary:
    "Runtime configurations and the retry-policy reader share generated, recursively frozen descriptors. The generator reads the public SDK export and retains exactly the configured presets.",
  enforcement: {
    kind: "import",
    specifiers: ["@playwright/test"],
    names: ["devices"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
