import { Generator, getConfig } from "@tanstack/router-generator";
import { panic } from "better-result";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_TREE_OPTIONS } from "../route-tree.config.ts";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
// The Start plugin resolves both paths under `srcDirectory`; so does this.
const srcRoot = path.join(webRoot, ROUTE_TREE_OPTIONS.srcDirectory);
const output = path.join(srcRoot, ROUTE_TREE_OPTIONS.generatedRouteTree);
const check = process.argv.slice(2).includes("--check");

if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  panic("Usage: bun scripts/generate-route-tree.ts [--check]");
}

// Keep the output beside the committed tree so generated import paths match.
const checkDirectory = check
  ? await mkdtemp(path.join(srcRoot, ".route-tree-check-"))
  : undefined;
const generatedRouteTree = checkDirectory
  ? path.join(srcRoot, `${path.basename(checkDirectory)}.ts`)
  : output;

try {
  const config = getConfig(
    {
      routesDirectory: path.join(srcRoot, ROUTE_TREE_OPTIONS.routesDirectory),
      generatedRouteTree,
    },
    webRoot,
  );
  await new Generator({ config, root: webRoot }).run();

  if (check) {
    const [actual, expected] = await Promise.all([
      readFile(output),
      readFile(generatedRouteTree),
    ]);
    if (!actual.equals(expected)) {
      panic(
        "apps/web/src/routeTree.gen.ts is stale; regenerate with bun --filter @stll/web generate:route-tree",
      );
    }
  }
} finally {
  if (checkDirectory) {
    await rm(generatedRouteTree, { force: true });
    await rm(checkDirectory, { recursive: true, force: true });
  }
}
