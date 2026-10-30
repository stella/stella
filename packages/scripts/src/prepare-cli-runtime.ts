import { childExitStatus } from "./child-exit-status";
import { hasPreparedGeneratedSources } from "./prepared-generated-sources";

const root = new URL("../../../", import.meta.url).pathname;
if (hasPreparedGeneratedSources(root)) {
  process.exit(0);
}
const apps = Bun.spawnSync(["bun", "scripts/prepare-mcp-apps.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (childExitStatus(apps) !== 0) {
  process.exit(childExitStatus(apps));
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
