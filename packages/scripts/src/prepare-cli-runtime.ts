import { childExitStatus } from "./child-exit-status";
import { hasPreparedGeneratedSources } from "./prepared-generated-sources";

const root = new URL("../../../", import.meta.url).pathname;
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
