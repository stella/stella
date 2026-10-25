#!/usr/bin/env bun
// Shipped static assets: every file under apps/*/public is copied into an
// image or deployed as-is, so dead weight there costs every pull and deploy
// while no import graph, typecheck or knip run can see it. Two checks:
//
// - Byte-identical raster files anywhere in the tree: keep one canonical file.
// - Files under apps/*/public that no consumer names: no source, config, HTML
//   or other public text file mentions their public path or file name. Write
//   the full literal path where an asset is used (`"/media/products/x.png"`,
//   not a template that assembles it), so this check and a reader's grep can
//   both find the consumer. A file fetched by convention rather than by
//   reference belongs in PUBLIC_ASSET_EXCEPTIONS with its reason.

import { panic } from "better-result";
import nodePath from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { createSha256 } from "@stll/sha256/bun";

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
    const paths = group.map(({ path }) => path).toSorted();
    duplicates.push({ ...first, path: paths[0] ?? first.path, paths });
  }
  return duplicates.toSorted((left, right) =>
    compareCodeUnit(left.path, right.path),
  );
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
    digest: createSha256().update(new Uint8Array(bytes)).digest("hex"),
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

const PUBLIC_ASSET = /^apps\/[^/]+\/public\/(?<publicPath>.+)$/u;
const CONSUMER_TEXT =
  /\.(?:astro|cjs|css|html|js|json|jsonc|jsx|md|mdx|mjs|mts|svg|ts|tsx|txt|webmanifest|xml)$/u;
const CONSUMER_LOCATION =
  /^(?:apps\/[^/]+\/(?:src|public)\/|apps\/[^/]+\/[^/]+\.(?:html|config\.[cm]?[jt]s)$|packages\/[^/]+\/src\/)/u;

// Fetched by convention, never named by a consumer. Each entry says who reads
// it; anything else unreferenced is dead weight and fails the check.
export const PUBLIC_ASSET_EXCEPTIONS: ReadonlyMap<RegExp, string> = new Map([
  [
    /^apps\/landing\/public\/[0-9a-f]{32}\.txt$/u,
    "IndexNow key file, fetched by search engines to verify the site's pings",
  ],
  [
    /^apps\/landing\/public\/fonts\/OFL-[^/]+\.txt$/u,
    "SIL Open Font License text, which must ship beside the font it covers",
  ],
  [
    /^apps\/landing\/public\/media\/products\/(?:case-law-search|contacts|import-export|invoicing|templates|time-tracking)(?:-dark)?\.png$/u,
    "product captures from #5964 for product pages not built yet; wire them into a page or delete them",
  ],
]);

const isConsumer = (filePath: string): boolean =>
  CONSUMER_TEXT.test(filePath) && CONSUMER_LOCATION.test(filePath);

export const findUnreferencedPublicAssets = async ({
  files,
  rootDir,
}: {
  files: readonly string[];
  rootDir: string;
}): Promise<string[]> => {
  const assets = files.filter(
    (filePath) =>
      PUBLIC_ASSET.test(filePath) &&
      ![...PUBLIC_ASSET_EXCEPTIONS.keys()].some((pattern) =>
        pattern.test(filePath),
      ),
  );
  const consumers = await Promise.all(
    files.filter(isConsumer).map(async (filePath) => {
      const file = Bun.file(nodePath.join(rootDir, filePath));
      return {
        filePath,
        text: (await file.exists()) ? await file.text() : "",
      };
    }),
  );
  return assets
    .filter((asset) => {
      const publicPath = PUBLIC_ASSET.exec(asset)?.groups?.publicPath ?? asset;
      const fileName = nodePath.basename(asset);
      return !consumers.some(
        ({ filePath, text }) =>
          filePath !== asset &&
          (text.includes(publicPath) || text.includes(fileName)),
      );
    })
    .toSorted(compareCodeUnit);
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
  const [duplicates, unreferenced] = await Promise.all([
    findDuplicateRasterAssets({ files, rootDir }),
    findUnreferencedPublicAssets({ files, rootDir }),
  ]);

  if (duplicates.length > 0) {
    console.error(
      "public-assets: byte-identical raster assets found. Keep one canonical file and reference it from every consumer:",
    );
    for (const { digest, paths, size } of duplicates) {
      console.error(
        `\n  ${size.toLocaleString("en-US")} bytes  sha256:${digest}`,
      );
      for (const filePath of paths) {
        console.error(`    ${filePath}`);
      }
    }
  }
  if (unreferenced.length > 0) {
    console.error(
      "public-assets: files under apps/*/public that nothing references. Delete them, or name each one by its literal public path where it is used; a file fetched by convention goes in PUBLIC_ASSET_EXCEPTIONS (scripts/check-public-assets.ts) with its reason:",
    );
    for (const filePath of unreferenced) {
      const { size } = Bun.file(nodePath.join(rootDir, filePath));
      console.error(`  ${size.toLocaleString("en-US")} bytes  ${filePath}`);
    }
  }
  if (duplicates.length > 0 || unreferenced.length > 0) {
    return 1;
  }
  console.log(
    `public-assets: OK. ${files.filter(isRasterAsset).length} raster assets and ${files.filter((filePath) => PUBLIC_ASSET.test(filePath)).length} public files checked.`,
  );
  return 0;
};

if (import.meta.main) {
  process.exitCode = await main();
}
