import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  findDuplicateRasterAssets,
  findUnreferencedPublicAssets,
  groupDuplicateRasterAssets,
  isRasterAsset,
} from "./check-public-assets";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true }),
      ),
  );
});

describe("duplicate raster asset guard", () => {
  test("recognizes supported raster extensions case-insensitively", () => {
    expect(isRasterAsset("public/hero.PNG")).toBe(true);
    expect(isRasterAsset("public/logo.svg")).toBe(false);
  });

  test("groups only identities with the same size and digest", () => {
    expect(
      groupDuplicateRasterAssets([
        { digest: "same", path: "z.png", size: 4 },
        { digest: "same", path: "a.webp", size: 4 },
        { digest: "same", path: "different-size.png", size: 5 },
        { digest: "unique", path: "unique.png", size: 4 },
      ]),
    ).toEqual([
      {
        digest: "same",
        path: "a.webp",
        paths: ["a.webp", "z.png"],
        size: 4,
      },
    ]);
  });

  test("hashes raster contents and ignores identical non-raster files", async () => {
    const rootDir = await mkdtemp(
      nodePath.join(tmpdir(), "stella-duplicate-assets-"),
    );
    temporaryDirectories.push(rootDir);
    await Promise.all([
      Bun.write(nodePath.join(rootDir, "first.png"), "same bytes"),
      Bun.write(nodePath.join(rootDir, "nested/second.jpg"), "same bytes"),
      Bun.write(nodePath.join(rootDir, "copy.txt"), "same bytes"),
      Bun.write(nodePath.join(rootDir, "different.png"), "different bytes"),
    ]);

    const duplicates = await findDuplicateRasterAssets({
      files: [
        "first.png",
        "nested/second.jpg",
        "copy.txt",
        "different.png",
        "deleted.png",
      ],
      rootDir,
    });

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.paths).toEqual(["first.png", "nested/second.jpg"]);
  });
});

describe("unreferenced public asset guard", () => {
  test("fails a public file only when no consumer names it", async () => {
    const rootDir = await mkdtemp(
      nodePath.join(tmpdir(), "stella-unreferenced-assets-"),
    );
    temporaryDirectories.push(rootDir);
    const files = {
      "apps/web/public/branding/used.webp": "bytes",
      "apps/web/public/branding/by-name.png": "bytes",
      "apps/web/public/branding/dead.webp": "bytes",
      "apps/web/public/self-named.svg":
        "<svg><title>self-named.svg</title></svg>",
      "apps/web/public/only-in-scripts.png": "bytes",
      "apps/landing/public/fonts/OFL-Example.txt": "license",
      "apps/landing/public/fonts/example.woff2": "bytes",
      "apps/web/src/routes/sign-in.tsx":
        'const background = "/branding/used.webp";\nconst logo = "by-name.png";\n',
      "apps/landing/src/styles/fonts.css":
        'src: url("/fonts/example.woff2") format("woff2");\n',
      "scripts/render.ts": 'const input = "only-in-scripts.png";\n',
      "docs/assets.md": "dead.webp was the old background\n",
    };
    await Promise.all(
      Object.entries(files).map(
        async ([filePath, text]) =>
          await Bun.write(nodePath.join(rootDir, filePath), text),
      ),
    );

    expect(
      await findUnreferencedPublicAssets({
        files: Object.keys(files),
        rootDir,
      }),
    ).toEqual([
      "apps/web/public/branding/dead.webp",
      "apps/web/public/only-in-scripts.png",
      "apps/web/public/self-named.svg",
    ]);
  });
});
