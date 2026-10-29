import { panic } from "better-result";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { MCP_APPS } from "../packages/mcp-apps/src/manifest";
import {
  MCP_APP_DIRECTORY_OUTPUTS,
  MCP_APP_GENERATED_OUTPUTS,
} from "../packages/scripts/src/generated-files";

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

export const missingMcpGeneratedOutputs = (root: string) => {
  const outputs = [
    ...MCP_APP_GENERATED_OUTPUTS.contracts,
    ...MCP_APP_GENERATED_OUTPUTS.bundles,
    ...MCP_APPS.flatMap(({ directory }) =>
      MCP_APP_DIRECTORY_OUTPUTS.map(
        (file) => `packages/mcp-apps/src/${directory}/generated/${file}`,
      ),
    ),
  ];
  return outputs.filter((file) => {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      return true;
    }
    // A style partition is empty when all its CSS belongs to the shared runtime.
    return !file.endsWith(".css.txt") && statSync(absolute).size === 0;
  });
};

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  checkMcpGeneratedTracking(root);
  if (Bun.argv.includes("--outputs")) {
    const missing = missingMcpGeneratedOutputs(root);
    if (missing.length > 0) {
      panic(`MCP generated outputs missing or empty:\n${missing.join("\n")}`);
    }
    console.log("MCP generated outputs match their owning inventories");
  }
}
