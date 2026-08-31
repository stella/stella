import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import path from "node:path";

import webManifest from "../apps/web/package.json" with { type: "json" };
import rootManifest from "../package.json" with { type: "json" };
import uiManifest from "../packages/ui/package.json" with { type: "json" };
import {
  distEntryFiles,
  sourceExportTargets,
  toPublishedManifest,
} from "./publish-manifest";

const ATLASKIT_DRAG_PACKAGE = "@atlaskit/pragmatic-drag-and-drop";
const ATLASKIT_AUTO_SCROLL_PACKAGE =
  "@atlaskit/pragmatic-drag-and-drop-auto-scroll";
const ATLASKIT_RUNTIME_PACKAGES = [
  ATLASKIT_DRAG_PACKAGE,
  ATLASKIT_AUTO_SCROLL_PACKAGE,
] as const;
const ATLASKIT_ELEMENT_ADAPTER =
  "@atlaskit/pragmatic-drag-and-drop/element/adapter";
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
        "./capability-catalog.json": "./capability-catalog.json",
      }),
      files: ["capability-catalog.json", "dist", "src", "README.md"],
    };

    expect(sourceExportTargets(withCatalog)).toEqual({
      ".": "./src/index.ts",
      "./capability-catalog.json": "./capability-catalog.json",
    });
    expect(toPublishedManifest(withCatalog).exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./capability-catalog.json": "./capability-catalog.json",
    });
  });

  test("rejects a root JSON asset omitted from files", () => {
    expect(() =>
      sourceExportTargets(
        manifest({
          ".": "./src/index.ts",
          "./capability-catalog.json": "./capability-catalog.json",
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
