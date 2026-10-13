import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  McpAppBundleReadError,
  MCP_APP_BUNDLE_PATHS,
  mcpAppBundlePath,
  readMcpAppBundle,
} from "./bundles";
import { MCP_APPS } from "./manifest";

test("all app bundles read unchanged bytes and missing output names the build command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bundles-"));
  try {
    expect(MCP_APP_BUNDLE_PATHS).toHaveLength(MCP_APPS.length);
    for (const { directory } of MCP_APPS) {
      const file = mcpAppBundlePath(directory, root);
      expect(path.relative(root, file).split(path.sep).join("/")).toBe(
        MCP_APP_BUNDLE_PATHS.find((candidate) =>
          candidate.includes(`/${directory}/`),
        ),
      );
      await mkdir(path.dirname(file), { recursive: true });
      const html = `<html>\n${directory}\n</html>\n`;
      await Bun.write(file, html);
      expect(await readMcpAppBundle(directory, root)).toBe(html);
      await rm(file);
      const error = await rejectionOf(readMcpAppBundle(directory, root));
      expect(error).toBeInstanceOf(McpAppBundleReadError);
      expect(error).toMatchObject({
        directory,
        message: `Cannot read MCP app bundle ${directory}. Run bun --filter @stll/mcp-apps build.`,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled consumers serve the same embedded bytes without source files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-compiled-bundles-"));
  try {
    const entry = path.join(root, "entry.ts");
    const binary = path.join(root, "reader");
    const directories = MCP_APPS.map(({ directory }) => directory);
    await Bun.write(
      entry,
      `import { readMcpAppBundle } from ${JSON.stringify(path.join(import.meta.dirname, "bundles.ts"))};\nfor (const directory of ${JSON.stringify(directories)}) console.log(Bun.hash(await readMcpAppBundle(directory)).toString());\n`,
    );
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      entry,
      "--outfile",
      binary,
    ]);
    expect(build.stderr.toString()).not.toContain("error:");
    expect(build.exitCode).toBe(0);
    const expected = await Promise.all(
      directories.map(async (directory) =>
        Bun.hash(await readMcpAppBundle(directory)).toString(),
      ),
    );
    const run = Bun.spawnSync([binary], { cwd: root });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim().split("\n")).toEqual(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
