#!/usr/bin/env bun
// Rewrite a package.json from its in-repo "source" shape to the published
// "dist" shape, in place. The transformation itself lives in
// scripts/publish-manifest.ts.
//
// Run this after `bun run build`, immediately before `bun pm pack` /
// `bun publish`. Restore the working tree afterward
// (`git checkout -- package.json`) — the publish workflow runs on an
// ephemeral checkout; the bootstrap script restores explicitly.

import { panic } from "better-result";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  assertShippedAssetPatternsMatch,
  toPublishedManifest,
} from "./publish-manifest";

const pkgDir =
  process.argv[2] ??
  panic("usage: bun scripts/prepare-publish.ts <package-dir>");

const pkgPath = path.resolve(pkgDir, "package.json");
const pkg = toPublishedManifest(await Bun.file(pkgPath).json());

// A shipped asset pattern that matches nothing would publish an export no
// consumer can import; refuse it before the manifest is rewritten.
assertShippedAssetPatternsMatch(pkg, (directory) => {
  const absolute = path.resolve(pkgDir, directory);
  return existsSync(absolute)
    ? readdirSync(absolute, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    : undefined;
});

await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  `prepared ${pkg.name}@${pkg.version} for publish (exports -> dist)`,
);
