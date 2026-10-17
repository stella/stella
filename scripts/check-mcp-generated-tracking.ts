import { panic } from "better-result";
import path from "node:path";

import { ciGeneratedFiles } from "../packages/scripts/src/generated-file-inventory";

export const trackedMcpGeneratedFiles = (files: readonly string[]) =>
  files.filter(
    (file) =>
      ![
        "packages/mcp-apps/src/shared/generated/style.css.d.ts",
        "packages/mcp-apps/src/shared/generated/tsconfig.json",
      ].includes(file) &&
      (file.startsWith("apps/api/src/mcp/generated/") ||
        /^apps\/api\/src\/mcp\/apps\/[^/]+\/generated\//u.test(file) ||
        /^packages\/mcp-apps\/src\/(?:[^/]+\/)?generated\//u.test(file)),
  );

export const checkMcpGeneratedTracking = (root: string) => {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: root,
  });
  if (tracked.exitCode !== 0) {
    panic(tracked.stderr.toString());
  }
  const files = trackedMcpGeneratedFiles(tracked.stdout.toString().split("\0"));
  if (files.length > 0) {
    panic(`MCP generated outputs must stay untracked:\n${files.join("\n")}`);
  }
  console.log("MCP generated outputs are untracked");
};

export const checkMcpGeneratedOutputs = async (root: string) => {
  const files = ciGeneratedFiles(root).filter((file) =>
    file.startsWith("packages/mcp-apps/src/"),
  );
  if (files.length === 0) {
    panic("No MCP app generated outputs are declared");
  }
  for (const file of files) {
    const output = Bun.file(path.join(root, file));
    if (!(await output.exists()) || output.size === 0) {
      panic(`MCP generated output is missing or empty: ${file}`);
    }
  }
};

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  checkMcpGeneratedTracking(root);
  if (process.argv.includes("--check-outputs")) {
    await checkMcpGeneratedOutputs(root);
  }
}
