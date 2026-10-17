import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ciGeneratedFiles } from "../packages/scripts/src/generated-file-inventory";
import {
  checkMcpGeneratedOutputs,
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

test("every declared MCP output must exist and contain data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-output-guard-"));
  try {
    const app = path.join(root, "packages/mcp-apps/src/reader/app.html");
    await mkdir(path.dirname(app), { recursive: true });
    await writeFile(app, "source");
    const files = ciGeneratedFiles(root).filter((file) =>
      file.startsWith("packages/mcp-apps/src/"),
    );
    for (const file of files) {
      const output = path.join(root, file);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, "generated");
    }
    await checkMcpGeneratedOutputs(root);
    for (const file of files) {
      const output = path.join(root, file);
      const message = `MCP generated output is missing or empty: ${file}`;
      await writeFile(output, "");
      expect(await rejectionOf(checkMcpGeneratedOutputs(root))).toMatchObject({
        message,
      });
      await rm(output);
      expect(await rejectionOf(checkMcpGeneratedOutputs(root))).toMatchObject({
        message,
      });
      await writeFile(output, "generated");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
