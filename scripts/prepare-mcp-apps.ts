import { panic } from "better-result";
import path from "node:path";

import { readRuntimeMode } from "../packages/runtime-mode/src/index";
import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { withGeneratedOutputCache } from "../packages/scripts/src/generated-output-cache";
import { hasPreparedGeneratedSources } from "../packages/scripts/src/prepared-generated-sources";
import { GENERATORS } from "./generated-files";

const root = path.resolve(import.meta.dirname, "..");
const owner =
  GENERATORS.find(({ id }) => id === "mcp-app-bundles") ??
  panic("Missing MCP app generator");

if (!hasPreparedGeneratedSources(root)) {
  await withGeneratedOutputCache({
    root,
    name: owner.id,
    environment: readRuntimeMode().nodeEnv,
    inputs: [
      ...owner.inputs,
      "scripts/prepare-mcp-apps.ts",
      "scripts/generated-files.ts",
      "packages/scripts/src/generated-output-cache.ts",
      "packages/scripts/src/generation-lock.ts",
    ],
    outputs: owner.outputs,
    generate: async () => {
      const generated = Bun.spawnSync([...owner.write], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      });
      if (childExitStatus(generated) !== 0) {
        panic("MCP app generation failed");
      }
    },
  });
}
