import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  missingMcpGeneratedOutputs,
  trackedMcpGeneratedFiles,
} from "./check-mcp-generated-tracking";

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
      "packages/mcp-apps/src/shared/generated/style.css.d.ts",
      "packages/mcp-apps/src/shared/generated/tsconfig.json",
    ]),
  ).toEqual(artifacts);
});

test("every generated output must exist, while shared CSS may leave empty style parts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-generated-outputs-"));
  try {
    const outputs = missingMcpGeneratedOutputs(root);
    expect(outputs.length).toBeGreaterThan(0);
    for (const file of outputs) {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, "generated");
    }
    expect(missingMcpGeneratedOutputs(root)).toEqual([]);
    for (const file of outputs) {
      const absolute = path.join(root, file);
      writeFileSync(absolute, "");
      expect(missingMcpGeneratedOutputs(root)).toEqual(
        file.endsWith(".css.txt") ? [] : [file],
      );
      rmSync(absolute);
      expect(missingMcpGeneratedOutputs(root)).toEqual([file]);
      writeFileSync(absolute, "generated");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
