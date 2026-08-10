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
import path from "node:path";

import { toPublishedManifest } from "./publish-manifest";

const pkgDir =
  process.argv[2] ??
  panic("usage: bun scripts/prepare-publish.ts <package-dir>");

const pkgPath = path.resolve(pkgDir, "package.json");
const pkg = toPublishedManifest(await Bun.file(pkgPath).json());

await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  `prepared ${pkg.name}@${pkg.version} for publish (exports -> dist)`,
);
