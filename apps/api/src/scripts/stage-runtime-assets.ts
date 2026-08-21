import { panic } from "better-result";
/**
 * Stage the runtime image's native assets into one directory.
 *
 * Run in the image builder stage:
 *   bun apps/api/src/scripts/stage-runtime-assets.ts /app/runtime-native
 *
 * Every asset is located through Bun's resolver from the workspace root and
 * copied with symlinks dereferenced, so the result is the same whether the
 * install was hoisted or isolated. A package that does not resolve, or a
 * selection that is missing or empty, fails the build here rather than the
 * first request that needs it.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  type ResolvePackageDir,
  type RuntimeAsset,
  STATIC_RUNTIME_ASSETS,
  sharpPlatformAssets,
} from "./runtime-asset-manifest";

const stagingRoot = process.argv[2];
if (stagingRoot === undefined || stagingRoot.length === 0) {
  console.error(
    "usage: bun apps/api/src/scripts/stage-runtime-assets.ts <staging-root>",
  );
  process.exit(2);
}

// Resolve from the workspace root: that is where the image installs.
const workspaceRoot = path.resolve(import.meta.dir, "../../../..");

const resolvePackageDir: ResolvePackageDir = (specifier) => {
  try {
    const manifest = Bun.resolveSync(
      `${specifier}/package.json`,
      workspaceRoot,
    );
    return path.dirname(realpathSync(manifest));
  } catch {
    return null;
  }
};

const stage = (asset: RuntimeAsset): string => {
  const packageDir = resolvePackageDir(asset.specifier);
  if (packageDir === null) {
    panic(`cannot resolve ${asset.specifier} from ${workspaceRoot}`);
  }
  const source = path.join(packageDir, asset.select);
  if (!existsSync(source)) {
    panic(`${asset.specifier}: ${asset.select} does not exist`);
  }
  const target = path.join(stagingRoot, asset.destination);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
  const staged = statSync(target);
  if (staged.isDirectory() && readdirSync(target).length === 0) {
    panic(`${asset.specifier}: ${asset.select} copied empty`);
  }
  return `${asset.specifier}/${asset.select} -> ${asset.destination}`;
};

const assets: RuntimeAsset[] = [
  ...STATIC_RUNTIME_ASSETS,
  ...sharpPlatformAssets({
    platform: process.platform,
    arch: process.arch,
    resolvePackageDir,
  }).packages,
];

for (const asset of assets) {
  console.log(`staged ${stage(asset)}`);
}
console.log(`staged ${assets.length} runtime assets under ${stagingRoot}`);
