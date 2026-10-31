import { Generator, getConfig } from "@tanstack/router-generator";
import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
import {
  routeTemplateManifest,
  routeTemplateManifestPlugin,
} from "./route-template-manifest";

test("route template manifest derives only full-path keys without runtime imports", () => {
  const generated = routeTemplateManifest(
    `import { Route } from './private-store'\nexport interface FileRoutesByFullPath {\n  '/chat/$threadId': typeof ChatRoute\n  '/': typeof IndexRoute\n}\nexport interface FileRoutesByTo {\n  '/ignored': typeof OtherRoute\n}`,
  );
  expect(generated).toContain('"/chat/$threadId"');
  expect(generated).toContain('"/"');
  expect(generated).not.toContain("private-store");
  expect(generated).not.toContain("/ignored");
  expect(() => routeTemplateManifest("not a generated tree")).toThrow(
    "Generated route tree has no full-path interface",
  );
});

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
  test.each(["missing", "stale"])(
    "restores a %s manifest when the same generator leaves its tree unchanged",
    async (state) => {
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
        const generatedRouteTree = path.join(directory, "routeTree.gen.ts");
        const manifest = path.join(directory, "route-templates.gen.ts");
        const config = getConfig(
          {
            routesDirectory,
            generatedRouteTree,
            plugins: [routeTemplateManifestPlugin(generatedRouteTree)],
          },
          directory,
        );
        const generator = new Generator({ config, root: directory });
        await generator.run();
        const tree = await readFile(generatedRouteTree, "utf-8");
        const treeTime = (await stat(generatedRouteTree)).mtimeMs;
        expect(await readFile(manifest, "utf-8")).toBe(
          routeTemplateManifest(tree),
        );
        if (state === "missing") {
          await rm(manifest);
        } else {
          await writeFile(manifest, "stale projection");
        }
        await generator.run();
        expect((await stat(generatedRouteTree)).mtimeMs).toBe(treeTime);
        expect(await readFile(manifest, "utf-8")).toBe(
          routeTemplateManifest(tree),
        );
        const manifestTime = (await stat(manifest)).mtimeMs;
        await generator.run();
        expect((await stat(manifest)).mtimeMs).toBe(manifestTime);
      });
    },
  );
  test("production router excludes the visual route and its import graph", async () => {
    await withDirectory(async (directory) => {
      const output = path.join(directory, "routeTree.gen.ts");
      await generateRouteTree(output, "serve");
      const development = await readFile(output, "utf-8");
      const templates = path.join(directory, "route-templates.gen.ts");
      expect(await readFile(templates, "utf-8")).toBe(
        routeTemplateManifest(development),
      );
      expect(development).toContain("/dev");
      expect(development).toContain("routes/dev");
      await generateRouteTree(output, "build");
      const production = await readFile(output, "utf-8");
      expect(await readFile(templates, "utf-8")).toBe(
        routeTemplateManifest(production),
      );
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
