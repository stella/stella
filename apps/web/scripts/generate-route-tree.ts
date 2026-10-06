import { Generator, getConfig } from "@tanstack/router-generator";
import { panic } from "better-result";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hasPreparedGeneratedSources } from "../../../packages/scripts/src/prepared-generated-sources";
import { ROUTE_TREE_OPTIONS } from "../route-tree.config.ts";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
// The Start plugin resolves both paths under `srcDirectory`; so does this.
const srcRoot = path.join(webRoot, ROUTE_TREE_OPTIONS.srcDirectory);
const output = path.join(srcRoot, ROUTE_TREE_OPTIONS.generatedRouteTree);
export const generateRouteTree = async (generatedRouteTree: string) => {
  const config = getConfig(
    {
      routesDirectory: path.join(srcRoot, ROUTE_TREE_OPTIONS.routesDirectory),
      generatedRouteTree,
    },
    webRoot,
  );
  await new Generator({ config, root: webRoot }).run();
};

export const checkRouteTreeDeterminism = async (
  sourceDirectory: string,
  generateTree: (generatedRouteTree: string) => Promise<void>,
) => {
  // Keep both fresh outputs beside the real tree so relative imports match.
  const checkDirectory = await mkdtemp(
    path.join(sourceDirectory, ".route-tree-check-"),
  );
  const first = `${checkDirectory}-first.ts`;
  const second = `${checkDirectory}-second.ts`;

  try {
    await generateTree(first);
    await generateTree(second);
    const [actual, expected] = await Promise.all([
      readFile(first),
      readFile(second),
    ]);
    if (!actual.equals(expected)) {
      panic(
        "Route tree generation is nondeterministic: two fresh outputs differ",
      );
    }
  } finally {
    await Promise.all([
      rm(first, { force: true }),
      rm(second, { force: true }),
    ]);
    await rm(checkDirectory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    panic("Usage: bun scripts/generate-route-tree.ts [--check]");
  }
  if (args.includes("--check")) {
    await checkRouteTreeDeterminism(srcRoot, generateRouteTree);
  } else if (
    !hasPreparedGeneratedSources(new URL("../../../", import.meta.url).pathname)
  ) {
    await generateRouteTree(output);
  }
}
