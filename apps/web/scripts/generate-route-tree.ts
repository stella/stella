import { Generator, getConfig } from "@tanstack/router-generator";
import { panic } from "better-result";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_TREE_OPTIONS } from "../route-tree.config.ts";

type GenerateRouteTreeOptions = { webRoot: string; mode: "write" | "check" };

export const generateRouteTree = async ({
  webRoot,
  mode,
}: GenerateRouteTreeOptions) => {
  // The Start plugin resolves both paths under `srcDirectory`; so does this.
  const srcRoot = path.join(webRoot, ROUTE_TREE_OPTIONS.srcDirectory);
  const output = path.join(srcRoot, ROUTE_TREE_OPTIONS.generatedRouteTree);
  const check = mode === "check";

  // Keep both generations beside the local tree so import paths match. Each
  // pass uses a fresh Generator, including its filesystem and route caches.
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
      const first = await readFile(generatedRouteTree);
      await rm(generatedRouteTree);
      await new Generator({ config, root: webRoot }).run();
      const second = await readFile(generatedRouteTree);
      if (!first.equals(second)) {
        panic(
          "apps/web/src/routeTree.gen.ts is not deterministic across two generations",
        );
      }
      await writeFile(output, first);
    }
  } finally {
    if (checkDirectory) {
      await rm(generatedRouteTree, { force: true });
      await rm(checkDirectory, { recursive: true, force: true });
    }
  }
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    panic("Usage: bun scripts/generate-route-tree.ts [--check]");
  }
  await generateRouteTree({
    webRoot: fileURLToPath(new URL("..", import.meta.url)),
    mode: args.includes("--check") ? "check" : "write",
  });
}
