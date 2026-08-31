import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  findDuplicateRasterAssets,
  groupDuplicateRasterAssets,
  isRasterAsset,
} from "./check-duplicate-raster-assets";

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
