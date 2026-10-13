import { panic } from "better-result";

export const trackedMcpGeneratedFiles = (files: readonly string[]) =>
  files.filter(
    (file) =>
      /^apps\/api\/src\/mcp\/generated\//u.test(file) ||
      /^apps\/api\/src\/mcp\/apps\/[^/]+\/generated\//u.test(file) ||
      /^packages\/mcp-apps\/src\/(?:[^/]+\/)?generated\//u.test(file),
  );

if (import.meta.main) {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: new URL("..", import.meta.url).pathname,
  });
  if (tracked.exitCode !== 0) {
    panic(tracked.stderr.toString());
  }
  const files = trackedMcpGeneratedFiles(tracked.stdout.toString().split("\0"));
  if (files.length > 0) {
    panic(`MCP generated outputs must stay untracked:\n${files.join("\n")}`);
  }
  console.log("MCP generated outputs are untracked");
}
