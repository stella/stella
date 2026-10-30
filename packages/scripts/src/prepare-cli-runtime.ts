import { childExitStatus } from "./child-exit-status";
import { hasPreparedGeneratedSources } from "./prepared-generated-sources";

const root = new URL("../../../", import.meta.url).pathname;
const apps = Bun.spawnSync(["bun", "scripts/prepare-mcp-apps.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (childExitStatus(apps) !== 0) {
  process.exit(childExitStatus(apps));
}
const catalog = Bun.spawnSync(
  ["bun", "apps/api/scripts/export-capability-catalog.ts", "--catalog-only"],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (childExitStatus(catalog) !== 0) {
  process.exit(childExitStatus(catalog));
}
if (!hasPreparedGeneratedSources(root)) {
  const result = Bun.spawnSync(
    ["bun", "packages/cli/src/codegen.ts", "--runtime-only"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(childExitStatus(result));
}
