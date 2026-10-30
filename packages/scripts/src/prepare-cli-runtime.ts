import { childExitStatus } from "./child-exit-status";
import { hasPreparedGeneratedSources } from "./prepared-generated-sources";

const root = new URL("../../../", import.meta.url).pathname;
const prepared = hasPreparedGeneratedSources(root);
if (!prepared) {
  const apps = Bun.spawnSync(["bun", "scripts/prepare-mcp-apps.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (childExitStatus(apps) !== 0) {
    process.exit(childExitStatus(apps));
  }
}
// Prepared artifacts contain runtime modules, not the npm catalog that CLI
// codegen and contract tests read. Generate those shards in either mode.
const catalog = Bun.spawnSync(
  ["bun", "apps/api/scripts/export-capability-catalog.ts", "--catalog-only"],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (childExitStatus(catalog) !== 0) {
  process.exit(childExitStatus(catalog));
}
if (prepared) {
  process.exit(0);
}
const runtime = Bun.spawnSync(
  ["bun", "apps/api/scripts/generate-capability-runtime.ts"],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (childExitStatus(runtime) !== 0) {
  process.exit(childExitStatus(runtime));
}
const result = Bun.spawnSync(
  ["bun", "packages/cli/scripts/codegen.ts", "--runtime-only"],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(childExitStatus(result));
