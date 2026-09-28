import { Generator, getConfig } from "@tanstack/router-generator";
import { panic } from "better-result";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(webRoot, "src/routeTree.gen.ts");
const check = process.argv.slice(2).includes("--check");

if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  panic("Usage: bun scripts/generate-route-tree.ts [--check]");
}

// Keep the output beside the committed tree so generated import paths match.
const checkDirectory = check
  ? await mkdtemp(path.join(webRoot, "src/.route-tree-check-"))
  : undefined;
const generatedRouteTree = checkDirectory
  ? path.join(webRoot, "src", `${path.basename(checkDirectory)}.ts`)
  : output;

try {
  const config = getConfig(
    {
      routesDirectory: "src/routes",
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
