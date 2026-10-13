import { TaggedError } from "better-result";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { MCP_APP_BUNDLE_PATHS } from "../../src/bundle-paths";
import { MCP_APPS } from "../../src/manifest";

const bundleOwners = new Set([
  "packages/mcp-apps/src/bundle-paths.ts",
  "packages/mcp-apps/src/embedded-bundles.ts",
  "packages/mcp-apps/scripts/lib/bundle-ownership.ts",
  "packages/mcp-apps/scripts/lib/bundle-ownership.test.ts",
  "turbo.json",
]);

const bundlePathCallers = {
  "packages/mcp-apps/src/bundle-paths.ts": "Canonical location owner.",
  "packages/mcp-apps/src/bundles.ts":
    "Checked reader and reader facade exports.",
  "packages/mcp-apps/scripts/build-mcp-apps.ts": "Canonical bundle writer.",
  "packages/mcp-apps/src/bundles.test.ts":
    "Isolated fixtures for checked-reader failures.",
  "packages/mcp-apps/scripts/mcp-app-styles.test.ts":
    "Isolated build-output fixtures.",
  "packages/mcp-apps/scripts/lib/bundle-ownership.ts": "Ownership detector.",
  "packages/mcp-apps/scripts/lib/bundle-ownership.test.ts":
    "Detector mutation fixtures.",
} as const;

const embeddedMapCallers = {
  "packages/mcp-apps/src/bundles.ts": "Only embedded HTML reader.",
  "packages/mcp-apps/src/embedded-bundles.ts": "Path-only import map.",
  "packages/mcp-apps/scripts/check-bundle-ownership.ts":
    "Inspects the path-only map.",
  "packages/mcp-apps/scripts/lib/bundle-ownership.ts": "Ownership detector.",
  "packages/mcp-apps/scripts/lib/bundle-ownership.test.ts":
    "Map inspection and mutation fixtures.",
} as const;

class BundleOwnershipGitError extends TaggedError("BundleOwnershipGitError")<{
  message: string;
}> {}

export const inspectBundleOwnership = async (root: string) => {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (tracked.exitCode !== 0) {
    throw new BundleOwnershipGitError({ message: tracked.stderr.toString() });
  }
  const files = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  );
  if (files.exitCode !== 0) {
    throw new BundleOwnershipGitError({ message: files.stderr.toString() });
  }
  const trackedFiles = new Set(tracked.stdout.toString().split("\0"));
  const findings = MCP_APP_BUNDLE_PATHS.filter((file) =>
    trackedFiles.has(file),
  ).map((file) => `Generated MCP bundle is tracked: ${file}`);
  for (const file of new Set(files.stdout.toString().split("\0"))) {
    if (!/\.(?:[cm]?[jt]sx?|json|ya?ml)$/u.test(file)) {
      continue;
    }
    const location = path.join(root, file);
    if (!existsSync(location)) {
      continue;
    }
    const source = await readFile(location, "utf-8");
    if (!bundleOwners.has(file) && source.includes("app.html.txt")) {
      findings.push(`MCP bundle path bypasses @stll/mcp-apps/bundles: ${file}`);
    }
    if (!(file in bundlePathCallers) && source.includes("mcpAppBundlePath")) {
      findings.push(`MCP bundle resolver bypasses the checked reader: ${file}`);
    }
    if (!(file in embeddedMapCallers) && source.includes("embedded-bundles")) {
      findings.push(`Embedded MCP bundles bypass the checked reader: ${file}`);
    }
  }
  return findings;
};

export const inspectEmbeddedBundleMap = (source: string) => {
  const imports = [
    ...source.matchAll(
      /import (\w+) from "\.\/([^/]+)\/generated\/app\.html\.txt" with \{ type: "text" \};/gu,
    ),
  ];
  const entries = [...source.matchAll(/"([^"\n]+)": (\w+),/gu)];
  const expected = MCP_APPS.map(({ directory }) => directory);
  const bindings = new Map(imports.map((match) => [match[1], match[2]]));
  if (
    imports.length !== expected.length ||
    entries.length !== expected.length ||
    new Set(entries.map((match) => match[1])).size !== expected.length ||
    entries.some(
      (match) =>
        !expected.some((directory) => directory === match[1]) ||
        bindings.get(match[2]) !== match[1],
    )
  ) {
    return ["Embedded bundle imports must match the MCP app manifest."];
  }
  // Only imports, the total map, and its type assertion may be committed here.
  const remainder = source
    .replace(
      /import \w+ from "\.\/[^/]+\/generated\/app\.html\.txt" with \{ type: "text" \};/gu,
      "",
    )
    .replace(/import type \{ MCP_APPS \} from "\.\/manifest";/u, "")
    .replace(/"[^"\n]+": \w+,/gu, "")
    .replace(/\s/gu, "");
  return remainder ===
    'exportconstMCP_APP_BUNDLES={}asconstsatisfiesRecord<(typeofMCP_APPS)[number]["directory"],string>;'
    ? []
    : ["The embedded bundle map may contain paths only, never bundle content."];
};
