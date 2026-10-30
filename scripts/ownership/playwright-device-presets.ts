import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "playwright-device-presets",
  capability: "Immutable Playwright device presets for configuration",
  owner: [
    "packages/playwright-tools/src/devices.ts",
    "packages/playwright-tools/src/devices.gen.ts",
    "packages/playwright-tools/src/device-preset-generator.ts",
    "scripts/generate-playwright-devices.ts",
  ],
  summary:
    "Runtime configurations and the retry-policy reader share generated, recursively frozen descriptors. The package generator helper reads the public SDK export, and the root generator retains exactly the configured presets.",
  enforcement: {
    kind: "import",
    specifiers: ["@playwright/test"],
    names: ["devices"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
