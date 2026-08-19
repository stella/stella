import { describe, expect, test } from "bun:test";

import {
  distEntryFiles,
  sourceExportTargets,
  toPublishedManifest,
} from "./publish-manifest";

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
