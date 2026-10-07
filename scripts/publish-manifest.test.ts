import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import path from "node:path";

import webManifest from "../apps/web/package.json" with { type: "json" };
import rootManifest from "../package.json" with { type: "json" };
import cliManifest from "../packages/cli/package.json" with { type: "json" };
import uiManifest from "../packages/ui/package.json" with { type: "json" };
import {
  assertShippedAssetPatternsMatch,
  distEntryFiles,
  matchShippedAssetPattern,
  sourceExportTargets,
  toPublishedManifest,
} from "./publish-manifest";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

const ATLASKIT_DRAG_PACKAGE = "@atlaskit/pragmatic-drag-and-drop";
const ATLASKIT_AUTO_SCROLL_PACKAGE =
  "@atlaskit/pragmatic-drag-and-drop-auto-scroll";
const ATLASKIT_RUNTIME_PACKAGES = [
  ATLASKIT_DRAG_PACKAGE,
  ATLASKIT_AUTO_SCROLL_PACKAGE,
] as const;
const ATLASKIT_ELEMENT_ADAPTER =
  "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
const ATLASKIT_AUTO_SCROLL_ELEMENT =
  "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

const manifest = (exports: Record<string, unknown>) => ({
  exports,
  files: ["dist", "src", "README.md"],
  name: "@stll/example",
  version: "1.2.3",
});

describe("sourceExportTargets", () => {
  test("accepts the module and asset extensions the builds emit", () => {
    expect(
      sourceExportTargets(
        manifest({
          ".": "./src/index.ts",
          "./button": "./src/components/button.tsx",
          "./theme.css": "./src/styles/theme.css",
        }),
      ),
    ).toEqual({
      ".": "./src/index.ts",
      "./button": "./src/components/button.tsx",
      "./theme.css": "./src/styles/theme.css",
    });
  });

  // A wildcard names no file, so nothing downstream can check that the build
  // emitted it or that the tarball ships it. The published map has to be
  // enumerated.
  test("rejects a wildcard target", () => {
    expect(() =>
      sourceExportTargets(manifest({ "./components/*": "./src/components/*" })),
    ).toThrow(/expected source export/u);
  });

  test("rejects conditions objects and targets outside src", () => {
    expect(() =>
      sourceExportTargets(manifest({ ".": { import: "./src/index.ts" } })),
    ).toThrow(/expected source export/u);
    expect(() =>
      sourceExportTargets(manifest({ ".": "./dist/index.js" })),
    ).toThrow(/expected source export/u);
    expect(() =>
      sourceExportTargets(manifest({ ".": "./src/index.json" })),
    ).toThrow(/expected source export/u);
  });

  test("accepts an exported root JSON asset when files ships it", () => {
    const withCatalog = {
      ...manifest({
        ".": "./src/index.ts",
        "./contract.json": "./contract.json",
      }),
      files: ["contract.json", "dist", "src", "README.md"],
    };

    expect(sourceExportTargets(withCatalog)).toEqual({
      ".": "./src/index.ts",
      "./contract.json": "./contract.json",
    });
    expect(toPublishedManifest(withCatalog).exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./contract.json": "./contract.json",
    });
  });

  test("accepts a JSON asset directory pattern the files allowlist ships", () => {
    const withShards = {
      ...manifest({
        ".": "./src/index.ts",
        "./capabilities/*.json": "./capabilities/*.json",
      }),
      files: ["capabilities", "dist", "src", "README.md"],
    };

    expect(sourceExportTargets(withShards)["./capabilities/*.json"]).toBe(
      "./capabilities/*.json",
    );
    const published = toPublishedManifest(withShards);
    expect(published.exports["./capabilities/*.json"]).toBe(
      "./capabilities/*.json",
    );
    expect(published["files"]).toEqual(["dist", "README.md", "capabilities"]);
  });

  // The release workflow is the only other place these manifests are
  // transformed, so a shape it would refuse has to fail here, on the PR.
  test("transforms every package the release publishes", async () => {
    for (const directory of ALL_PACKAGE_ORDER) {
      const source: unknown = await Bun.file(
        path.join(REPO_ROOT, "packages", directory, "package.json"),
      ).json();
      expect(() => toPublishedManifest(source), directory).not.toThrow();
    }
  });

  test("ships the CLI's capability shards as an asset pattern", () => {
    const published = toPublishedManifest(cliManifest);
    expect(published.exports["./capabilities/*.json"]).toBe(
      "./capabilities/*.json",
    );
    expect(published["files"]).toContain("capabilities");
  });

  test("rejects a JSON asset pattern whose directory files does not ship", () => {
    expect(() =>
      sourceExportTargets(
        manifest({
          ".": "./src/index.ts",
          "./capabilities/*.json": "./capabilities/*.json",
        }),
      ),
    ).toThrow(/expected source export "\.\/capabilities\/\*\.json"/u);
  });

  test("rejects asset patterns in any other shape", () => {
    const shipping = (exports: Record<string, unknown>) => ({
      ...manifest(exports),
      files: ["capabilities", "dist", "src", "README.md", "..", ".hidden"],
    });
    for (const [subpath, target] of [
      // Remapped: the subpath has to name the file it resolves to.
      ["./caps/*.json", "./capabilities/*.json"],
      // Not JSON, or not one level of files.
      ["./capabilities/*", "./capabilities/*"],
      ["./capabilities/*.js", "./capabilities/*.js"],
      ["./capabilities/**/*.json", "./capabilities/**/*.json"],
      // Built directories go through the module and stylesheet rules.
      ["./src/*.json", "./src/*.json"],
      ["./dist/*.json", "./dist/*.json"],
      // Nothing may climb out of the package or hide in a dot directory.
      ["./../*.json", "./../*.json"],
      ["./.hidden/*.json", "./.hidden/*.json"],
    ] as const) {
      expect(() =>
        sourceExportTargets(
          shipping({ ".": "./src/index.ts", [subpath]: target }),
        ),
      ).toThrow(/expected source export/u);
    }
  });

  test("rejects a root JSON asset omitted from files", () => {
    expect(() =>
      sourceExportTargets(
        manifest({
          ".": "./src/index.ts",
          "./contract.json": "./contract.json",
        }),
      ),
    ).toThrow(/expected source export/u);
  });
});

describe("toPublishedManifest", () => {
  const published = toPublishedManifest(
    manifest({
      ".": "./src/index.ts",
      "./button": "./src/components/button.tsx",
      "./theme.css": "./src/styles/theme.css",
    }),
  );

  test("compiles modules to their built pair, whatever the source extension", () => {
    expect(published.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(published.exports["./button"]).toEqual({
      types: "./dist/components/button.d.ts",
      import: "./dist/components/button.js",
    });
  });

  // A stylesheet is copied, not compiled: the consumer owns the Tailwind
  // build, so the published entry points at the file itself.
  test("keeps a copied stylesheet as a single dist path", () => {
    expect(published.exports["./theme.css"]).toBe("./dist/styles/theme.css");
  });

  test("ships dist and the README, never src", () => {
    expect(published["files"]).toEqual(["dist", "README.md"]);
    expect(published["main"]).toBe("./dist/index.js");
    expect(published["types"]).toBe("./dist/index.d.ts");
  });

  test("requires a root export, and requires it to be a module", () => {
    expect(() =>
      toPublishedManifest(
        manifest({ "./button": "./src/components/button.tsx" }),
      ),
    ).toThrow(/exports must include a "\." entry/u);
    expect(() =>
      toPublishedManifest(manifest({ ".": "./src/styles/theme.css" })),
    ).toThrow(/must be a module/u);
  });

  test("preserves the UI kanban's drag runtime contract", () => {
    const publishedUi = toPublishedManifest(uiManifest);

    for (const packageName of ATLASKIT_RUNTIME_PACKAGES) {
      const uiRange = uiManifest.devDependencies[packageName];
      expect(uiManifest.peerDependencies[packageName]).toBe(uiRange);
      expect(webManifest.dependencies[packageName]).toBe(uiRange);
    }

    expect(
      Bun.semver.satisfies(
        rootManifest.resolutions[ATLASKIT_DRAG_PACKAGE],
        uiManifest.devDependencies[ATLASKIT_DRAG_PACKAGE],
      ),
    ).toBe(true);
    expect(publishedUi["peerDependencies"]).toEqual(
      uiManifest.peerDependencies,
    );
  });

  test("resolves one element adapter across the UI, web, and auto-scroll", () => {
    const uiAdapter = Bun.resolveSync(
      ATLASKIT_ELEMENT_ADAPTER,
      path.join(REPO_ROOT, "packages/ui"),
    );
    const webAdapter = Bun.resolveSync(
      ATLASKIT_ELEMENT_ADAPTER,
      path.join(REPO_ROOT, "apps/web"),
    );
    const autoScrollElement = Bun.resolveSync(
      ATLASKIT_AUTO_SCROLL_ELEMENT,
      REPO_ROOT,
    );
    const autoScrollAdapter = Bun.resolveSync(
      ATLASKIT_ELEMENT_ADAPTER,
      path.dirname(autoScrollElement),
    );

    expect(realpathSync(uiAdapter)).toBe(realpathSync(webAdapter));
    expect(realpathSync(autoScrollAdapter)).toBe(realpathSync(webAdapter));
  });
});

describe("shipped asset patterns after the build", () => {
  const published = toPublishedManifest({
    ...manifest({
      ".": "./src/index.ts",
      "./capabilities/*.json": "./capabilities/*.json",
    }),
    files: ["capabilities", "dist"],
  });

  test("matches only JSON files directly inside the directory, sorted", () => {
    expect(
      matchShippedAssetPattern("./capabilities/*.json", [
        "b.get.json",
        "README.md",
        "a.list.json",
        "nested/c.json",
      ]),
    ).toEqual(["capabilities/a.list.json", "capabilities/b.get.json"]);
  });

  test("passes when the built directory holds a matching file", () => {
    expect(() =>
      assertShippedAssetPatternsMatch(published, (directory) =>
        directory === "capabilities" ? ["a.list.json"] : undefined,
      ),
    ).not.toThrow();
  });

  test("refuses a pattern whose directory is missing or holds no match", () => {
    expect(() =>
      assertShippedAssetPatternsMatch(published, () => undefined),
    ).toThrow(/matches no file in capabilities\/ after the build/u);
    expect(() =>
      assertShippedAssetPatternsMatch(published, () => ["README.md"]),
    ).toThrow(/matches no file in capabilities\/ after the build/u);
  });
});

describe("distEntryFiles", () => {
  test("names every file an entry points at", () => {
    expect(
      distEntryFiles({ types: "./dist/a.d.ts", import: "./dist/a.js" }),
    ).toEqual(["./dist/a.d.ts", "./dist/a.js"]);
    expect(distEntryFiles("./dist/styles/theme.css")).toEqual([
      "./dist/styles/theme.css",
    ]);
  });
});
