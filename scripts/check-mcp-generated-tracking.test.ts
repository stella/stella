import { expect, test } from "bun:test";

import { trackedMcpGeneratedFiles } from "./check-mcp-generated-tracking";

test("MCP generated outputs stay outside the Git index", () => {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: new URL("..", import.meta.url).pathname,
  });
  expect(tracked.exitCode).toBe(0);
  expect(
    trackedMcpGeneratedFiles(tracked.stdout.toString().split("\0")),
  ).toEqual([]);
});

test("the tracking guard detects every MCP generated tree", () => {
  const artifacts = [
    "apps/api/src/mcp/generated/capability-dispatch/new.ts",
    "apps/api/src/mcp/generated/capability-catalog.ts",
    "apps/api/src/mcp/apps/new-app/generated/app.html.txt",
    "packages/mcp-apps/src/new-app/generated/app.html.txt",
    "packages/mcp-apps/src/shared/generated/style.css",
    "packages/mcp-apps/src/generated/bundles.ts",
  ];
  expect(
    trackedMcpGeneratedFiles([
      ...artifacts,
      "packages/mcp-apps/src/manifest.ts",
    ]),
  ).toEqual(artifacts);
});
