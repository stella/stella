import { fileURLToPath } from "node:url";

import { childExitStatus } from "./child-exit-status";
import { hasPreparedGeneratedSources } from "./prepared-generated-sources";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const prepared = hasPreparedGeneratedSources(root);

const runCommand = async (command: readonly string[]): Promise<number> => {
  const child = Bun.spawn([...command], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
  return childExitStatus(child);
};

if (!prepared) {
  const appsStatus = await runCommand(["bun", "scripts/prepare-mcp-apps.ts"]);
  if (appsStatus !== 0) {
    process.exit(appsStatus);
  }
}

// Prepared artifacts contain runtime modules, not the npm catalog that CLI
// codegen and contract tests read. Generate those shards in either mode; when
// runtime modules also need generation, run both independent generators in
// parallel.
if (prepared) {
  const catalogStatus = await runCommand([
    "bun",
    "apps/api/scripts/export-capability-catalog.ts",
    "--catalog-only",
  ]);
  process.exit(catalogStatus);
}

const [catalogStatus, runtimeStatus] = await Promise.all([
  runCommand([
    "bun",
    "apps/api/scripts/export-capability-catalog.ts",
    "--catalog-only",
  ]),
  runCommand(["bun", "apps/api/scripts/generate-capability-runtime.ts"]),
]);
if (catalogStatus !== 0) {
  process.exit(catalogStatus);
}
if (runtimeStatus !== 0) {
  process.exit(runtimeStatus);
}

const codegenStatus = await runCommand([
  "bun",
  "packages/cli/scripts/codegen.ts",
  "--runtime-only",
]);
process.exit(codegenStatus);
