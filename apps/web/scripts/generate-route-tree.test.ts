import { Generator, getConfig } from "@tanstack/router-generator";
import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { routeTreeOptions } from "../route-tree.config";
import {
  checkRouteTreeDeterminism,
  generateRouteTree,
} from "./generate-route-tree";

const withDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "route-tree-determinism-"),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("route tree determinism", () => {
  test("production router excludes the visual route and its import graph", async () => {
    await withDirectory(async (directory) => {
      const output = path.join(directory, "routeTree.gen.ts");
      await generateRouteTree(output, "serve");
      const development = await readFile(output, "utf-8");
      expect(development).toContain("/dev");
      expect(development).toContain("routes/dev");
      await generateRouteTree(output, "build");
      const production = await readFile(output, "utf-8");
      expect(production).not.toMatch(/['"]\/dev(?:['"/])/u);
      expect(production).not.toMatch(/routes\/dev(?:[.'"/])/u);
      expect(production).not.toContain("playground");
      expect(production).toContain("routes/index");
    });
  });

  test("production ignores every dev route file and the whole fixture directory", () => {
    const pattern = routeTreeOptions("build").routeFileIgnorePattern;
    expect(pattern).toBeDefined();
    const ignored = new RegExp(pattern ?? "", "u");
    for (const name of ["dev", "dev.tsx", "dev.new-fixture.tsx"]) {
      expect(ignored.test(name)).toBe(true);
    }
    expect(ignored.test("device.tsx")).toBe(false);
    expect(routeTreeOptions("serve").routeFileIgnorePattern).toBeUndefined();
  });

  test.each(["missing", "stale"])(
    "compares fresh outputs when the normal tree is %s",
    async (state) => {
      await withDirectory(async (directory) => {
        const output = path.join(directory, "routeTree.gen.ts");
        if (state === "stale") {
          await writeFile(output, "stale generated tree");
        }
        const generatedPaths = new Set<string>();
        await checkRouteTreeDeterminism(
          directory,
          async (generatedRouteTree) => {
            expect(path.dirname(generatedRouteTree)).toBe(directory);
            expect(
              await stat(generatedRouteTree).then(
                () => true,
                () => false,
              ),
            ).toBe(false);
            generatedPaths.add(generatedRouteTree);
            await writeFile(generatedRouteTree, "identical fresh tree");
          },
        );
        expect(generatedPaths.size).toBe(2);
        expect(await readdir(directory)).toEqual(
          state === "stale" ? ["routeTree.gen.ts"] : [],
        );
        if (state === "stale") {
          expect(await readFile(output, "utf-8")).toBe("stale generated tree");
        }
      });
    },
  );

  test("rejects injected nondeterminism and removes temporary outputs", async () => {
    await withDirectory(async (directory) => {
      let generation = 0;
      const [outcome] = await Promise.allSettled([
        checkRouteTreeDeterminism(directory, async (generatedRouteTree) => {
          generation += 1;
          await writeFile(generatedRouteTree, `generated tree ${generation}`);
        }),
      ]);
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: {
          message: expect.stringContaining(
            "Route tree generation is nondeterministic",
          ),
        },
      });
      expect(generation).toBe(2);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test("TanStack generates identical imports from two independent output paths", async () => {
    await withDirectory(async (directory) => {
      const routesDirectory = path.join(directory, "routes");
      await mkdir(routesDirectory);
      await writeFile(
        path.join(routesDirectory, "__root.tsx"),
        "import { createRootRoute } from '@tanstack/react-router'\nexport const Route = createRootRoute()\n",
      );
      await writeFile(
        path.join(routesDirectory, "index.tsx"),
        "import { createFileRoute } from '@tanstack/react-router'\nexport const Route = createFileRoute('/')({})\n",
      );
      const trees: string[] = [];
      await checkRouteTreeDeterminism(directory, async (generatedRouteTree) => {
        const config = getConfig(
          { routesDirectory, generatedRouteTree },
          directory,
        );
        await new Generator({ config, root: directory }).run();
        trees.push(await readFile(generatedRouteTree, "utf-8"));
      });
      expect(trees).toHaveLength(2);
      expect(trees.at(0)).toContain("./routes/index");
      expect(trees.at(0)).toBe(trees.at(1));
      expect(await readdir(directory)).toEqual(["routes"]);
    });
  });
});
