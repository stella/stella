import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MCP_APP_BUNDLE_PATHS } from "../../src/bundles";
import {
  inspectBundleOwnership,
  inspectEmbeddedBundleMap,
} from "./bundle-ownership";

test("repository census rejects direct bundle access and forced tracked output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bundle-guard-"));
  try {
    expect(
      Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode,
    ).toBe(0);
    await Bun.write(
      path.join(root, ".gitignore"),
      "**/generated/app.html.txt\n",
    );
    expect(await inspectBundleOwnership(root)).toEqual([]);
    await Bun.write(
      path.join(root, "reader.ts"),
      'await Bun.file("packages/mcp-apps/src/decision-reader/generated/app.html.txt").text();',
    );
    expect(await inspectBundleOwnership(root)).toEqual([
      "MCP bundle path bypasses @stll/mcp-apps/bundles: reader.ts",
    ]);
    await rm(path.join(root, "reader.ts"));
    await Bun.write(
      path.join(root, "reader.ts"),
      'import { MCP_APP_BUNDLES } from "./packages/mcp-apps/src/embedded-bundles";',
    );
    expect(await inspectBundleOwnership(root)).toEqual([
      "Embedded MCP bundles bypass the checked reader: reader.ts",
    ]);
    await Bun.write(
      path.join(root, "reader.ts"),
      'import { mcpAppBundlePath } from "@stll/mcp-apps/bundles"; await Bun.file(mcpAppBundlePath("decision-reader")).text();',
    );
    expect(await inspectBundleOwnership(root)).toEqual([
      "MCP bundle resolver bypasses the checked reader: reader.ts",
    ]);
    await rm(path.join(root, "reader.ts"));
    for (const file of MCP_APP_BUNDLE_PATHS) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await Bun.write(path.join(root, file), "<html></html>");
    }
    expect(await inspectBundleOwnership(root)).toEqual([]);
    expect(
      Bun.spawnSync(["git", "add", "-f", "--", ...MCP_APP_BUNDLE_PATHS], {
        cwd: root,
      }).exitCode,
    ).toBe(0);
    expect(await inspectBundleOwnership(root)).toEqual(
      MCP_APP_BUNDLE_PATHS.map(
        (file) => `Generated MCP bundle is tracked: ${file}`,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded imports mirror the manifest and contain no serialized HTML", async () => {
  const source = await Bun.file(
    path.join(import.meta.dirname, "../../src/embedded-bundles.ts"),
  ).text();
  expect(inspectEmbeddedBundleMap(source)).toEqual([]);
  expect(
    inspectEmbeddedBundleMap(
      source.replace('"decision-reader": app3', '"decision-reader": app0'),
    ),
  ).toEqual(["Embedded bundle imports must match the MCP app manifest."]);
  expect(
    inspectEmbeddedBundleMap(
      `${source}\nconst html = "<html>bundled content</html>";`,
    ),
  ).toEqual([
    "The embedded bundle map may contain paths only, never bundle content.",
  ]);
});
