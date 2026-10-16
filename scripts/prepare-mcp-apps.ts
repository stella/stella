import { panic } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";

import { readRuntimeMode } from "../packages/runtime-mode/src/index";
import { withGeneratedOutputCache } from "../packages/scripts/src/generated-output-cache";
import { hasPreparedGeneratedSources } from "../packages/scripts/src/prepared-generated-sources";
import { checkMcpGeneratedTracking } from "./check-mcp-generated-tracking";
import { GENERATORS } from "./generated-files";

const root = path.resolve(import.meta.dirname, "..");
// Source archives and image stages have no Git index to validate.
if (existsSync(path.join(root, ".git"))) {
  checkMcpGeneratedTracking(root);
}
const owners = ["mcp-app-contracts", "mcp-app-bundles"].map(
  (id) =>
    GENERATORS.find((owner) => owner.id === id) ??
    panic(`Missing MCP app generator: ${id}`),
);

if (!hasPreparedGeneratedSources(root)) {
  await withGeneratedOutputCache({
    root,
    name: "mcp-apps",
    environment: readRuntimeMode().nodeEnv,
    inputs: [
      ...owners.flatMap(({ inputs }) => inputs),
      "apps/api/src/**",
      "packages/**",
      "package.json",
      "bunfig.toml",
      "patches/**",
      "scripts/prepare-mcp-apps.ts",
      "scripts/check-mcp-generated-tracking.ts",
      "scripts/generated-files.ts",
      "packages/scripts/src/generated-output-cache.ts",
      "packages/scripts/src/generation-lock.ts",
      // Concurrent package builds write these; the Turbo task excludes them too.
      "!packages/**/dist/**",
      "!packages/**/*.tsbuildinfo",
      "!packages/**/.env*",
      "!apps/api/src/**/.env*",
    ],
    outputs: owners.flatMap(({ outputs }) => outputs),
    generate: async () => {
      for (const owner of owners) {
        const generated = Bun.spawn([...owner.write], {
          cwd: root,
          stdout: "inherit",
          stderr: "inherit",
        });
        if ((await generated.exited) !== 0) {
          panic(`MCP app generation failed: ${owner.id}`);
        }
      }
    },
  });
}
