import { panic } from "better-result";

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

if (import.meta.main) {
  checkMcpGeneratedTracking(new URL("..", import.meta.url).pathname);
}
