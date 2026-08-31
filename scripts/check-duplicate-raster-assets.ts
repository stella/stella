#!/usr/bin/env bun

import { panic } from "better-result";
import nodePath from "node:path";

const RASTER_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

export type RasterIdentity = {
  digest: string;
  path: string;
  size: number;
};

export type DuplicateRasterGroup = RasterIdentity & {
  paths: string[];
};

export const isRasterAsset = (filePath: string): boolean =>
  RASTER_EXTENSIONS.has(nodePath.extname(filePath).toLowerCase());

export const groupDuplicateRasterAssets = (
  identities: readonly RasterIdentity[],
): DuplicateRasterGroup[] => {
  const byDigest = new Map<string, RasterIdentity[]>();
  for (const identity of identities) {
    const key = `${identity.size}:${identity.digest}`;
    const group = byDigest.get(key);
    if (group === undefined) {
      byDigest.set(key, [identity]);
    } else {
      group.push(identity);
    }
  }

  const duplicates: DuplicateRasterGroup[] = [];
  for (const group of byDigest.values()) {
    const first = group.at(0);
    if (first === undefined || group.length < 2) {
      continue;
    }
    const paths = group.map(({ path }) => path).sort();
    duplicates.push({ ...first, path: paths[0] ?? first.path, paths });
  }
  return duplicates.sort((left, right) => left.path.localeCompare(right.path));
};

const hashRaster = async (
  rootDir: string,
  filePath: string,
): Promise<RasterIdentity | undefined> => {
  const file = Bun.file(nodePath.join(rootDir, filePath));
  if (!(await file.exists())) {
    return undefined;
  }
  const bytes = await file.arrayBuffer();
  return {
    digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    path: filePath,
    size: bytes.byteLength,
  };
};

export const findDuplicateRasterAssets = async ({
  files,
  rootDir,
}: {
  files: readonly string[];
  rootDir: string;
}): Promise<DuplicateRasterGroup[]> => {
  const rasterFiles = files.filter(isRasterAsset);
  const maybeIdentities = await Promise.all(
    rasterFiles.map(async (filePath) => await hashRaster(rootDir, filePath)),
  );
  const identities = maybeIdentities.filter(
    (identity): identity is RasterIdentity => identity !== undefined,
  );
  return groupDuplicateRasterAssets(identities);
};

const listRepositoryFiles = (rootDir: string): string[] => {
  const result = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
    ],
    { cwd: rootDir, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    return panic(
      `could not list repository files: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().split("\0").filter(Boolean);
};

const main = async (): Promise<number> => {
  const rootDir = nodePath.resolve(import.meta.dir, "..");
  const files = listRepositoryFiles(rootDir);
  const duplicates = await findDuplicateRasterAssets({ files, rootDir });

  if (duplicates.length === 0) {
    console.log(
      `duplicate-raster-assets: OK. ${files.filter(isRasterAsset).length} raster assets checked.`,
    );
    return 0;
  }

  console.error(
    "duplicate-raster-assets: byte-identical raster assets found. Keep one canonical file and reference it from every consumer:",
  );
  for (const { digest, paths, size } of duplicates) {
    console.error(
      `\n  ${size.toLocaleString("en-US")} bytes  sha256:${digest}`,
    );
    for (const filePath of paths) {
      console.error(`    ${filePath}`);
    }
  }
  return 1;
};

if (import.meta.main) {
  process.exitCode = await main();
}
